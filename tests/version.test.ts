import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { computeWorkspaceVersion } from "../src/core/version.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-version-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

describe("computeWorkspaceVersion", () => {
  it.runIf(hasGit)("same bytes -> same version", () => {
    const dir = tmpRepo();
    try {
      fs.writeFileSync(path.join(dir, "a.py"), "x = 1\n");
      const v1 = computeWorkspaceVersion(dir);
      const v2 = computeWorkspaceVersion(dir);
      expect(v1).toBe(v2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("edit -> different version, revert -> same version", () => {
    const dir = tmpRepo();
    try {
      const original = "x = 1\n";
      fs.writeFileSync(path.join(dir, "a.py"), original);
      const vBase = computeWorkspaceVersion(dir);
      fs.writeFileSync(path.join(dir, "a.py"), "x = 2\n");
      const vChanged = computeWorkspaceVersion(dir);
      expect(vChanged).not.toBe(vBase);
      fs.writeFileSync(path.join(dir, "a.py"), original);
      expect(computeWorkspaceVersion(dir)).toBe(vBase);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("untracked file changes the version", () => {
    const dir = tmpRepo();
    try {
      const v1 = computeWorkspaceVersion(dir);
      fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
      const v2 = computeWorkspaceVersion(dir);
      expect(v2).not.toBe(v1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("content changes inside an untracked directory change the version", () => {
    const dir = tmpRepo();
    try {
      const nested = path.join(dir, "new", "nested.txt");
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, "first\n");
      const v1 = computeWorkspaceVersion(dir);
      fs.writeFileSync(nested, "second\n");
      expect(computeWorkspaceVersion(dir)).not.toBe(v1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
