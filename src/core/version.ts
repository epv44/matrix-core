import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function runGit(args: string[], cwd: string): string {
  try {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 8000 });
    if (res.error || res.status !== 0) return "";
    return (res.stdout || "").trim();
  } catch {
    return "";
  }
}

function hashBytes(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashFile(p: string): string {
  try {
    return hashBytes(fs.readFileSync(p));
  } catch {
    return "";
  }
}

interface VersionEntry {
  path: string;
  state: string;
  hash: string;
}

function gitEntries(root: string): VersionEntry[] {
  const raw = runGit(["status", "--porcelain", "-z", "--untracked-files=all"], root);
  const entries: VersionEntry[] = [];
  if (!raw) return entries;
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const rel = tok.slice(3);
    if (!rel) continue;
    if (rel === ".quality" || rel.startsWith(".quality/")) continue;
    const abs = path.join(root, rel);
    const state = xy.trim() || "??";
    entries.push({ path: rel, state, hash: state === "D" ? "" : hashFile(abs) });
  }
  return entries;
}

function fallbackEntries(root: string): VersionEntry[] {
  const entries: VersionEntry[] = [];
  const skip = new Set([".git", "node_modules", "dist", ".quality", "coverage"]);
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) entries.push({ path: path.relative(root, p), state: "U", hash: hashFile(p) });
    }
  };
  walk(root);
  return entries;
}

/**
 * Compute a deterministic workspace fingerprint.
 *
 * Invariant: same bytes -> same version. Built from the git HEAD plus the
 * sorted set of (path, file state, content hash) for every changed/untracked
 * file, so reverting an edit restores the prior version.
 */
export function computeWorkspaceVersion(cwd: string): string {
  const root = path.resolve(cwd);
  const head = runGit(["rev-parse", "HEAD"], root);
  let entries = gitEntries(root);
  if (entries.length === 0 && !head) entries = fallbackEntries(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return hashBytes(Buffer.from(JSON.stringify({ head, entries }), "utf8"));
}
