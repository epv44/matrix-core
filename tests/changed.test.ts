import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isGitRepo, getChangedFiles, getChangedPaths, filterPythonFiles } from "../src/core/changed.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "matrix-changed-"));
}

function gitInit(dir: string) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

describe("filterPythonFiles", () => {
  it("keeps only .py files", () => {
    expect(filterPythonFiles(["a.py", "b.ts", "c/d.py", "e.go", "f.test.py"])).toEqual(["a.py", "c/d.py", "f.test.py"]);
  });
});

describe("isGitRepo / getChangedFiles", () => {
  it("non-repo directory returns no files and is not a git repo", () => {
    const dir = tmpDir();
    try {
      expect(isGitRepo(dir)).toBe(false);
      expect(getChangedFiles({ cwd: dir })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("reports untracked files", () => {
    const dir = tmpDir();
    try {
      gitInit(dir);
      const p = path.join(dir, "new.py");
      fs.writeFileSync(p, "x = 1\n");
      expect(isGitRepo(dir)).toBe(true);
      expect(getChangedFiles({ cwd: dir })).toContain(path.join(fs.realpathSync(dir), "new.py"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("reports modified committed files", () => {
    const dir = tmpDir();
    try {
      gitInit(dir);
      const p = path.join(dir, "app.ts");
      fs.writeFileSync(p, "const a = 1;\n");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
      fs.writeFileSync(p, "const a = 2;\n");
      expect(getChangedFiles({ cwd: dir })).toContain(path.join(fs.realpathSync(dir), "app.ts"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("retains deleted paths for review without sending them to file-based tools", () => {
    const dir = tmpDir();
    try {
      gitInit(dir);
      const deleted = path.join(dir, "architecture.md");
      fs.writeFileSync(deleted, "# Architecture\n");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
      fs.unlinkSync(deleted);
      expect(getChangedPaths({ cwd: dir })).toContain(path.join(fs.realpathSync(dir), "architecture.md"));
      expect(getChangedFiles({ cwd: dir })).not.toContain(path.join(fs.realpathSync(dir), "architecture.md"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("requires an explicit base before including committed branch changes", () => {
    const dir = tmpDir();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "base.ts"), "export const base = true;\n");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["commit", "-m", "base"], { cwd: dir });
      spawnSync("git", ["switch", "-q", "-c", "feature"], { cwd: dir });
      const feature = path.join(dir, "feature.ts");
      fs.writeFileSync(feature, "export const feature = true;\n");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["commit", "-m", "feature"], { cwd: dir });
      expect(getChangedPaths({ cwd: dir })).toEqual([]);
      expect(getChangedPaths({ cwd: dir, base: "main" })).toContain(path.join(fs.realpathSync(dir), "feature.ts"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
