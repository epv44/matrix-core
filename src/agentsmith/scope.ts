import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getChangedPaths } from "../core/changed.js";
import { computeWorkspaceVersion } from "../core/version.js";
import type { FileEntry, ReviewOmission } from "./engine-types.js";

export interface ReviewScope {
  id: string;
  version: string;
  root: string;
  base: string;
  diff: string;
  changedFiles: string[];
  /** Paths whose fileContents value is the frozen pre-deletion content. */
  deletedFiles?: string[];
  fileContents: Record<string, string>;
  suppliedContext: Record<string, string>;
  manifest: FileEntry[];
  omissions: ReviewOmission[];
  languages: string[];
  metadata: { fileCount: number; additions: number; deletions: number; capturedAt: string };
}

const GENERATED_PATH =
  /(^|\/)(dist|build|coverage|vendor|node_modules|\.next|target)\/|(^|\/)evals\/agentsmith\/[^/]+\/input\.json$/;
const GENERATED_MARKER = /(generated (file|code)|do not edit|@generated)/i;
function detectedLanguage(file: string): string | undefined {
  if (/\.(ts|tsx|js|jsx)$/.test(file)) return "typescript";
  if (/\.(py|pyi)$/.test(file)) return "python";
  if (/\.go$/.test(file)) return "go";
  if (/\.rs$/.test(file)) return "rust";
  return undefined;
}
function isBinary(content: string): boolean {
  return content.includes("\0");
}
function lineStats(diff: string) {
  const result = new Map<string, { additions: number; deletions: number; oldPath?: string }>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      file = header[2];
      result.set(file, { additions: 0, deletions: 0, ...(header[1] !== header[2] ? { oldPath: header[1] } : {}) });
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) result.get(file)!.additions++;
    else if (file && line.startsWith("-") && !line.startsWith("---")) result.get(file)!.deletions++;
  }
  return result;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 8000 });
  return result.status === 0 ? result.stdout || "" : "";
}

function safeRead(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

function deletedPreimage(root: string, relative: string, base: string): string {
  const candidates = ["HEAD"];
  for (const ref of [base, `origin/${base}`]) {
    const mergeBase = git(root, ["merge-base", ref, "HEAD"]).trim();
    if (mergeBase) candidates.push(mergeBase);
    candidates.push(ref);
  }
  for (const ref of [...new Set(candidates)]) {
    const content = git(root, ["show", `${ref}:${relative}`]);
    if (content) return content;
  }
  return "";
}

export function captureReviewScope(opts: { root: string; base?: string; contextFiles?: string[] }): ReviewScope {
  const root = fs.realpathSync(path.resolve(opts.root));
  const base = opts.base ?? "main";
  const version = computeWorkspaceVersion(root);
  const changedFiles = getChangedPaths({ cwd: root, base })
    .map((file) => path.relative(root, file))
    .sort();
  const deletedFiles = changedFiles.filter((file) => !fs.existsSync(path.resolve(root, file)));
  const deleted = new Set(deletedFiles);
  const fileContents = Object.fromEntries(
    changedFiles.map((file) => [file, deleted.has(file) ? deletedPreimage(root, file, base) : safeRead(root, file)]),
  );
  const suppliedContext = Object.fromEntries((opts.contextFiles ?? []).map((file) => [file, safeRead(root, file)]));
  const sections = [git(root, ["diff", `${base}...HEAD`]), git(root, ["diff", "--cached"]), git(root, ["diff"])];
  const tracked = new Set(git(root, ["ls-files"]).split("\n").filter(Boolean));
  for (const file of changedFiles)
    if (!tracked.has(file))
      sections.push(
        `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${fileContents[file].split("\n").length} @@\n${fileContents[
          file
        ]
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`,
      );
  const diff = sections.filter(Boolean).join("\n");
  const stats = lineStats(diff);
  const manifest: FileEntry[] = changedFiles.map((file) => {
    const content = fileContents[file] ?? "";
    const item = stats.get(file) ?? { additions: content.split("\n").length, deletions: 0 };
    const deletedFile = deleted.has(file);
    const generated = GENERATED_PATH.test(file) || GENERATED_MARKER.test(content.split("\n").slice(0, 10).join("\n"));
    return {
      path: file,
      changeKind: deletedFile ? "deleted" : item.oldPath ? "renamed" : item.deletions === 0 ? "added" : "modified",
      additions: item.additions,
      deletions: item.deletions,
      language: detectedLanguage(file),
      generated,
      binary: isBinary(content),
      sizeBytes: Buffer.byteLength(content),
      oldPath: item.oldPath,
    };
  });
  const omissions: ReviewOmission[] = [];
  for (const file of manifest) {
    if (file.binary) omissions.push({ kind: "file", id: file.path, reason: "binary" });
    else if (file.generated) omissions.push({ kind: "file", id: file.path, reason: "generated" });
  }
  const languages = [
    ...new Set(manifest.map((file) => file.language).filter((value): value is string => Boolean(value))),
  ].sort();
  const capturedAt = new Date().toISOString();
  const metadata = {
    fileCount: manifest.length,
    additions: manifest.reduce((sum, file) => sum + file.additions, 0),
    deletions: manifest.reduce((sum, file) => sum + file.deletions, 0),
    capturedAt,
  };
  const id = crypto
    .createHash("sha256")
    .update(JSON.stringify({ version, base, diff, deletedFiles, fileContents, suppliedContext, manifest, omissions }))
    .digest("hex");
  return {
    id,
    version,
    root,
    base,
    diff,
    changedFiles,
    deletedFiles,
    fileContents,
    suppliedContext,
    manifest,
    omissions,
    languages,
    metadata,
  };
}
