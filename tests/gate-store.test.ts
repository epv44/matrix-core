import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeGateResult, readGateResult } from "../src/core/gate-store.js";
import { gateStorePath } from "../src/core/meta.js";
import type { GateResult } from "../src/core/types.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";

function sampleGate(over: Partial<GateResult> = {}): GateResult {
  return {
    schemaVersion: 2,
    version: "abc123",
    mode: "full",
    fast: false,
    baseBranch: "main",
    changedFilesHash: null,
    changedFileCount: 0,
    status: "PASS",
    checks: [],
    failures: [],
    metrics: {},
    timestamp: new Date().toISOString(),
    createdBy: { tool: "quality_run", adapter: "cline", engineVersion: "0.1.0" },
    workspaces: [],
    workspaceHash: "workspace",
    policy: resolvePolicy(),
    toolVersions: {},
    ...over,
  };
}

describe("gate-store", () => {
  it("round-trips a gate result", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gatestore-"));
    try {
      const gate = sampleGate({ status: "FAIL", failures: ["ruff: 1 violations"] });
      writeGateResult(dir, gate);
      const read = readGateResult(dir);
      expect(read).toEqual(gate);
      expect(fs.existsSync(gateStorePath(dir))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no gate exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gatestore-"));
    try {
      expect(readGateResult(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites on write (RUNNING -> terminal)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gatestore-"));
    try {
      writeGateResult(dir, sampleGate({ status: "RUNNING" }));
      writeGateResult(dir, sampleGate({ status: "PASS" }));
      expect(readGateResult(dir)?.status).toBe("PASS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores changed and completion evidence independently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-gatestore-"));
    try {
      const changed = sampleGate({
        mode: "changed",
        fast: true,
        changedFilesHash: "changed-hash",
        changedFileCount: 2,
      });
      const completion = sampleGate({ mode: "full", fast: false });
      writeGateResult(dir, completion);
      writeGateResult(dir, changed);
      expect(readGateResult(dir, "full")).toEqual(completion);
      expect(readGateResult(dir, "changed")).toEqual(changed);
      expect(fs.existsSync(gateStorePath(dir, "full"))).toBe(true);
      expect(fs.existsSync(gateStorePath(dir, "changed"))).toBe(true);

      const fastFull = sampleGate({ mode: "full", fast: true });
      writeGateResult(dir, fastFull);
      expect(readGateResult(dir, "changed")).toEqual(fastFull);
      expect(readGateResult(dir, "full")).toEqual(completion);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
