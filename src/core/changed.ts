import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

function runGit(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 8000 });
    if (res.error) return { ok: false, out: "" };
    return { ok: res.status === 0, out: (res.stdout || "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

export type ChangedPathSource = "committed-delta" | "index" | "working-tree" | "untracked";

export interface ChangedPathEntry {
  path: string;
  sources: ChangedPathSource[];
}

export function isGitRepo(cwd: string): boolean {
  const r = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.out === "true";
}

/**
 * Return every changed path, including tracked files that no longer exist in
 * the worktree. Review scope needs deleted paths; deterministic tools normally
 * want getChangedFiles(), which retains the historical existing-file contract.
 */
export function getChangedPathEntries(opts: { cwd: string; base?: string }): ChangedPathEntry[] {
  const cwd = path.resolve(opts.cwd);
  if (!isGitRepo(cwd)) return [];

  const topRes = runGit(["rev-parse", "--show-toplevel"], cwd);
  const repoRoot = topRes.ok ? topRes.out : cwd;
  const files = new Map<string, Set<ChangedPathSource>>();
  const add = (output: string, source: ChangedPathSource) => {
    for (const file of output.split("\n").filter(Boolean)) {
      const sources = files.get(file) ?? new Set<ChangedPathSource>();
      sources.add(source);
      files.set(file, sources);
    }
  };

  if (opts.base) {
    const diffBase = runGit(["diff", "--name-only", `${opts.base}...HEAD`], cwd);
    if (diffBase.ok) add(diffBase.out, "committed-delta");
  }

  const diffCached = runGit(["diff", "--name-only", "--cached"], cwd);
  if (diffCached.ok) add(diffCached.out, "index");

  const diffUnstaged = runGit(["diff", "--name-only"], cwd);
  if (diffUnstaged.ok) add(diffUnstaged.out, "working-tree");

  const others = runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  if (others.ok) add(others.out, "untracked");

  return Array.from(files.entries())
    .filter(([f]) => {
      const relative = f.replaceAll("\\", "/").replace(/^\.\//, "");
      return relative !== ".quality" && !relative.startsWith(".quality/");
    })
    .map(([file, sources]) => ({
      path: path.isAbsolute(file) ? file : path.join(repoRoot, file),
      sources: [...sources].sort(),
    }));
}

export function getChangedPaths(opts: { cwd: string; base?: string }): string[] {
  return getChangedPathEntries(opts).map((entry) => entry.path);
}

export function getChangedFiles(opts: { cwd: string; base?: string }): string[] {
  return getChangedPaths(opts).filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function filterPythonFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".py"));
}
