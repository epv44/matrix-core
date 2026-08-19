import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runGate, gatePassesForVersion, resolveConfigRoot, detectWorkspaceMutation } from "../src/core/gate.js";
import { readGateResult } from "../src/core/gate-store.js";
import { computeWorkspaceVersion } from "../src/core/version.js";
import type { GateResult } from "../src/core/types.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function gitInit(dir: string) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function gate(status: GateResult["status"], version: string): GateResult {
  return {
    schemaVersion: 2,
    version,
    mode: "full",
    fast: false,
    baseBranch: "main",
    changedFilesHash: null,
    changedFileCount: 0,
    status,
    checks: [],
    failures: [],
    metrics: {},
    timestamp: new Date().toISOString(),
    createdBy: { tool: "test", adapter: "test", engineVersion: "0.0.0" },
    workspaces: [],
    workspaceHash: "workspace",
    policy: resolvePolicy(),
    toolVersions: {},
  };
}

describe("gatePassesForVersion", () => {
  it("requires a PASS gate for the exact version", () => {
    expect(gatePassesForVersion(null, "v1")).toBe(false);
    expect(gatePassesForVersion(gate("PASS", "v1"), "v1")).toBe(true);
    expect(gatePassesForVersion(gate("PASS", "v1"), "v2")).toBe(false);
    expect(gatePassesForVersion(gate("FAIL", "v1"), "v1")).toBe(false);
    expect(gatePassesForVersion(gate("RUNNING", "v1"), "v1")).toBe(false);
  });
});

describe("runGate", () => {
  it("persists a PASS gate versioned to the workspace state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gate-"));
    try {
      fs.writeFileSync(path.join(dir, "quality.yaml"), "version: 2\nproject: gate-test\n");
      const r = await runGate({ cwd: dir, mode: "full", tool: "test", adapter: "vitest" });
      expect(r.status).toBe("PASS");
      expect(r.createdBy.tool).toBe("test");
      expect(r).toMatchObject({ schemaVersion: 2, mode: "full", fast: false, changedFilesHash: null });
      expect(r.version).toBe(computeWorkspaceVersion(dir));
      expect(r.checks).toEqual([]);
      expect(r.policy?.checks).toHaveLength(8);
      const persisted = readGateResult(dir);
      expect(persisted?.status).toBe("PASS");
      expect(resolveConfigRoot(dir)).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records reproducible changed-run scope without replacing completion evidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gate-"));
    try {
      fs.writeFileSync(path.join(dir, "quality.yaml"), "version: 2\nproject: gate-test\n");
      fs.writeFileSync(path.join(dir, "one.txt"), "one\n");
      const full = await runGate({ cwd: dir, mode: "full", tool: "test", adapter: "vitest" });
      const changed = await runGate({
        cwd: dir,
        mode: "changed",
        fast: true,
        base: "develop",
        changedFiles: ["one.txt"],
        tool: "test",
        adapter: "vitest",
      });
      expect(changed).toMatchObject({
        schemaVersion: 2,
        mode: "changed",
        fast: true,
        baseBranch: "develop",
        changedFileCount: 1,
      });
      expect(changed.changedFilesHash).toMatch(/^[a-f0-9]{64}$/);
      expect(readGateResult(dir, "full")).toEqual(full);
      expect(readGateResult(dir, "changed")).toEqual(changed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectWorkspaceMutation", () => {
  it("returns empty when versions match", () => {
    expect(detectWorkspaceMutation("/tmp/matrix-gate", "abc", "abc")).toEqual([]);
  });

  it.runIf(hasGit)("returns changed file paths when version differs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gate-"));
    try {
      gitInit(dir);
      const p = path.join(dir, "a.py");
      fs.writeFileSync(p, "x = 1\n");
      const v1 = computeWorkspaceVersion(dir);
      fs.writeFileSync(p, "x = 2\n");
      const v2 = computeWorkspaceVersion(dir);
      expect(v1).not.toBe(v2);
      expect(detectWorkspaceMutation(dir, v1, v2)).toContain("a.py");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
