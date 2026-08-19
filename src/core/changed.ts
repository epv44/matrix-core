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

export function isGitRepo(cwd: string): boolean {
  const r = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.out === "true";
}

/**
 * Return every changed path, including tracked files that no longer exist in
 * the worktree. Review scope needs deleted paths; deterministic tools normally
 * want getChangedFiles(), which retains the historical existing-file contract.
 */
export function getChangedPaths(opts: { cwd: string; base?: string }): string[] {
  const cwd = path.resolve(opts.cwd);
  if (!isGitRepo(cwd)) return [];

  const topRes = runGit(["rev-parse", "--show-toplevel"], cwd);
  const repoRoot = topRes.ok ? topRes.out : cwd;
  const base = opts.base || "main";

  const files = new Set<string>();

  const diffBase = runGit(["diff", "--name-only", `${base}...HEAD`], cwd);
  if (diffBase.ok)
    diffBase.out
      .split("\n")
      .filter(Boolean)
      .forEach((f) => files.add(f));

  const diffMain = runGit(["diff", "--name-only", `origin/${base}...HEAD`], cwd);
  if (diffMain.ok)
    diffMain.out
      .split("\n")
      .filter(Boolean)
      .forEach((f) => files.add(f));

  const diffCached = runGit(["diff", "--name-only", "--cached"], cwd);
  if (diffCached.ok)
    diffCached.out
      .split("\n")
      .filter(Boolean)
      .forEach((f) => files.add(f));

  const diffUnstaged = runGit(["diff", "--name-only"], cwd);
  if (diffUnstaged.ok)
    diffUnstaged.out
      .split("\n")
      .filter(Boolean)
      .forEach((f) => files.add(f));

  const others = runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  if (others.ok)
    others.out
      .split("\n")
      .filter(Boolean)
      .forEach((f) => files.add(f));

  return Array.from(files)
    .filter((f) => {
      const relative = f.replaceAll("\\", "/").replace(/^\.\//, "");
      return relative !== ".quality" && !relative.startsWith(".quality/");
    })
    .map((f) => (path.isAbsolute(f) ? f : path.join(repoRoot, f)));
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
