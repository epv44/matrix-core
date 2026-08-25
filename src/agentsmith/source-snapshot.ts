import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteFile } from "../core/filesystem.js";
import { sha256, sha256Json } from "../core/hash.js";
import { computeWorkspaceVersion } from "../core/version.js";

export const SOURCE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface SourceSnapshotEntry {
  path: string;
  type: "file" | "symlink";
  sha256: string;
  size: number;
  executable: boolean;
  linkTarget?: string;
}

export interface SourceSnapshotManifest {
  schemaVersion: 1;
  repositoryFingerprint: string;
  gitHead: string | null;
  entries: SourceSnapshotEntry[];
  deletedPaths: string[];
}

export interface CapturedSourceSnapshot {
  manifest: SourceSnapshotManifest;
  manifestHash: string;
  fileCount: number;
  totalBytes: number;
  complete: boolean;
  portable: boolean;
  captureDurationMs: number;
  warnings: string[];
}

function git(root: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8") {
  return spawnSync("git", args, { cwd: root, encoding: encoding as BufferEncoding, timeout: 30_000 });
}

function normalizedRepositoryPath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function sourceObjectsRoot(root: string): string {
  return path.join(root, ".quality", "traces", "agentsmith", "_objects", "sha256");
}

export function sourceObjectPath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid source snapshot digest: ${digest}`);
  return path.join(sourceObjectsRoot(root), digest.slice(0, 2), digest.slice(2));
}

function storeObject(root: string, digest: string, contents: Buffer): void {
  const target = sourceObjectPath(root, digest);
  if (!fs.existsSync(target)) atomicWriteFile(target, contents, 0o600);
}

function currentHead(root: string): string | null {
  const result = git(root, ["rev-parse", "HEAD"]);
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function safeSymlink(root: string, file: string, target: string): boolean {
  if (path.isAbsolute(target)) return false;
  const resolved = path.resolve(path.dirname(path.join(root, file)), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function sourceManifestHash(manifest: SourceSnapshotManifest): string {
  return sha256Json(manifest);
}

export function captureSourceSnapshot(rootInput: string, expectedVersion: string): CapturedSourceSnapshot {
  const started = Date.now();
  const root = fs.realpathSync(rootInput);
  const warnings: string[] = [];
  let portable = true;
  const before = computeWorkspaceVersion(root);
  const listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], "buffer");
  if (listed.status !== 0) warnings.push(`source enumeration failed: ${String(listed.stderr).trim()}`);
  const paths =
    listed.status === 0
      ? [...new Set((listed.stdout as unknown as Buffer).toString("utf8").split("\0").filter(Boolean))]
          .map(normalizedRepositoryPath)
          .filter((file) => file !== ".quality" && !file.startsWith(".quality/"))
          .sort()
      : [];
  const entries: SourceSnapshotEntry[] = [];
  const deletedPaths: string[] = [];
  for (const file of paths) {
    const absolute = path.join(root, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      deletedPaths.push(file);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(absolute);
      if (!safeSymlink(root, file, linkTarget)) {
        portable = false;
        warnings.push(`nonportable symlink: ${file} -> ${linkTarget}`);
      }
      entries.push({
        path: file,
        type: "symlink",
        sha256: sha256(linkTarget),
        size: Buffer.byteLength(linkTarget),
        executable: false,
        linkTarget,
      });
      continue;
    }
    if (!stat.isFile()) {
      portable = false;
      warnings.push(`unsupported repository entry: ${file}`);
      continue;
    }
    const contents = fs.readFileSync(absolute);
    const digest = sha256(contents);
    storeObject(root, digest, contents);
    entries.push({
      path: file,
      type: "file",
      sha256: digest,
      size: contents.length,
      executable: Boolean(stat.mode & 0o111),
    });
  }
  const after = computeWorkspaceVersion(root);
  if (before !== expectedVersion || after !== expectedVersion)
    warnings.push(
      `workspace changed during source capture: expected ${expectedVersion}, before ${before}, after ${after}`,
    );
  const manifest: SourceSnapshotManifest = {
    schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
    repositoryFingerprint: expectedVersion,
    gitHead: currentHead(root),
    entries,
    deletedPaths: [...new Set(deletedPaths)].sort(),
  };
  return {
    manifest,
    manifestHash: sourceManifestHash(manifest),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    complete: listed.status === 0 && before === expectedVersion && after === expectedVersion,
    portable,
    captureDurationMs: Date.now() - started,
    warnings,
  };
}

export function materializeSourceManifest(
  sourceRoot: string,
  manifest: SourceSnapshotManifest,
  destination: string,
): void {
  const destinationRoot = path.resolve(destination);
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    const normalized = path.normalize(entry.path).replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized !== entry.path || path.isAbsolute(entry.path) || paths.has(entry.path))
      throw new Error(`Invalid or duplicate source snapshot path: ${entry.path}`);
    paths.add(entry.path);
    const target = path.resolve(destinationRoot, entry.path);
    if (target === destinationRoot || !target.startsWith(`${destinationRoot}${path.sep}`))
      throw new Error(`Source snapshot path escapes destination: ${entry.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.type === "symlink") {
      if (
        !entry.linkTarget ||
        sha256(entry.linkTarget) !== entry.sha256 ||
        Buffer.byteLength(entry.linkTarget) !== entry.size ||
        !safeSymlink(destinationRoot, entry.path, entry.linkTarget)
      )
        throw new Error(`Unsafe source snapshot symlink: ${entry.path}`);
      fs.symlinkSync(entry.linkTarget, target);
      continue;
    }
    const source = sourceObjectPath(sourceRoot, entry.sha256);
    const contents = fs.readFileSync(source);
    if (sha256(contents) !== entry.sha256 || contents.length !== entry.size)
      throw new Error(`Corrupt source snapshot object: ${entry.sha256}`);
    fs.writeFileSync(target, contents, { mode: entry.executable ? 0o755 : 0o644 });
  }
}
