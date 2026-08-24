import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { childProcessEnv, describeToolProbe, probeToolVersion } from "../src/core/process-env.js";
import { coordinateQualityCompletion } from "../src/core/completion-coordinator.js";
import { clearActiveGateRun, readGateResult, writeActiveGateRun, writeGateResult } from "../src/core/gate-store.js";
import { computeWorkspaceVersion } from "../src/core/version.js";
import { resolveConfig } from "../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../src/core/resolved-policy.js";
import { resolveWorkspaceSet } from "../src/core/workspace.js";
import { engineRuntimeIdentity, recordEngineRuntime } from "../src/core/runtime.js";
import { startMatrixCoreMcpServer } from "../src/mcp/server.js";
import type { GateResult, QualityCompletionResult } from "../src/core/types.js";

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-completion-regression-"));
  fs.writeFileSync(
    path.join(root, "quality.yaml"),
    "version: 2\nproject: completion-regression\nreview:\n  agentsmith: false\n",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), ".quality/\n");
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "MatrixCore Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function gate(root: string, status: GateResult["status"] = "PASS"): GateResult {
  const resolved = resolveConfig({ cwd: root });
  const policy = resolvePolicyForConfig(resolved);
  const workspaces = resolveWorkspaceSet(root, resolved.config.application);
  const runtime = engineRuntimeIdentity();
  return {
    schemaVersion: 2,
    version: computeWorkspaceVersion(root),
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
    createdBy: {
      tool: "test",
      adapter: "test",
      engineVersion: runtime.version,
      enginePath: runtime.executablePath,
      enginePackageRoot: runtime.packageRoot,
    },
    workspaces: workspaces.workspaces,
    workspaceHash: workspaces.workspaceHash,
    policy,
    toolVersions: {},
  };
}

function completion(result: GateResult): QualityCompletionResult {
  return {
    version: result.version,
    gate: result,
    review: null,
    reviewEnabled: false,
    advisory: true,
    passed: true,
    deterministicPassed: true,
    completionAllowed: true,
    reviewMarkdown: "",
    reviewArtifact: null,
    advisoryReview: {
      status: "disabled",
      verdict: null,
      findings: [],
      errors: [],
      profileId: null,
      profileHash: null,
    },
  };
}

describe("completion regressions", () => {
  it.runIf(process.platform !== "win32")("runs Node shims when the host PATH omits the MatrixCore Node runtime", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-node-shim-"));
    const shim = path.join(directory, "tool");
    fs.writeFileSync(shim, "#!/usr/bin/env node\nconsole.log('9.9.9')\n", { mode: 0o755 });
    const original = process.env.PATH;
    try {
      process.env.PATH = directory;
      expect(childProcessEnv().PATH?.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
      expect(probeToolVersion(shim)).toMatchObject({ found: true, version: "9.9.9", exitCode: 0 });
    } finally {
      process.env.PATH = original;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the real spawn failure instead of calling every probe missing", () => {
    const probe = probeToolVersion(path.join(os.tmpdir(), "matrix-does-not-exist"));
    expect(probe).toMatchObject({ found: false, errorCode: "ENOENT" });
    expect(describeToolProbe("fixture", probe)).toContain("ENOENT");
  });

  it("does not replace terminal PASS while another full gate is active", () => {
    const root = repository();
    try {
      const passed = gate(root, "PASS");
      writeGateResult(root, passed);
      writeActiveGateRun(root, "run-1", { ...passed, status: "RUNNING" });
      expect(readGateResult(root, "full")?.status).toBe("PASS");
      clearActiveGateRun(root, "run-1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent completion calls for one repository", async () => {
    const root = repository();
    try {
      let executions = 0;
      const expected = completion(gate(root));
      const execute = async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return expected;
      };
      const [first, second] = await Promise.all([
        coordinateQualityCompletion(root, undefined, execute),
        coordinateQualityCompletion(root, undefined, execute),
      ]);
      expect(executions).toBe(1);
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans per-process MCP runtime records during cooperative shutdown", async () => {
    const root = repository();
    const input = new PassThrough();
    const output = new PassThrough();
    try {
      recordEngineRuntime(root, "mcp");
      const runtimeFile = path.join(root, ".quality", "mcp-runtime", `${process.pid}.json`);
      expect(fs.existsSync(runtimeFile)).toBe(true);
      const running = await startMatrixCoreMcpServer({ stdin: input, stdout: output, installSignalHandlers: false });
      input.end();
      await vi.waitFor(() => expect(fs.existsSync(runtimeFile)).toBe(false));
      await running.close();
    } finally {
      input.destroy();
      output.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
