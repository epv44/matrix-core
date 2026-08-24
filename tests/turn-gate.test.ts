import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeWorkspaceVersion } from "../src/core/version.js";
import { turnStore } from "../src/core/turn-store.js";
import { renderHookDecision } from "../src/hooks/runner.js";
import { resolveConfig } from "../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../src/core/resolved-policy.js";
import { writeGateResult } from "../src/core/gate-store.js";
import { resolveWorkspaceSet } from "../src/core/workspace.js";
import { currentToolVersions } from "../src/core/status.js";
import { engineRuntimeIdentity } from "../src/core/runtime.js";
import { ENGINE_VERSION } from "../src/core/meta.js";
import type { GateResult } from "../src/core/types.js";

function tempRepo(configured = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-turn-gate-"));
  if (configured)
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: turn-test\nreview:\n  agentsmith: false\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".quality/\n");
  fs.writeFileSync(path.join(root, "file.txt"), "one\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "MatrixCore Test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

describe("turn completion invariant", () => {
  it("changes when only the staged index changes", () => {
    const root = tempRepo();
    try {
      const file = path.join(root, "file.txt");
      fs.writeFileSync(file, "staged-one\n");
      spawnSync("git", ["add", "file.txt"], { cwd: root });
      fs.writeFileSync(file, "worktree\n");
      const before = computeWorkspaceVersion(root);

      fs.writeFileSync(file, "staged-two\n");
      spawnSync("git", ["add", "file.txt"], { cwd: root });
      fs.writeFileSync(file, "worktree\n");

      expect(computeWorkspaceVersion(root)).not.toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps failed validation dirty and records validated completion only for PASS", () => {
    const root = tempRepo();
    try {
      const hash = computeWorkspaceVersion(root);
      const policyHash = resolvePolicyForConfig(resolveConfig({ cwd: root })).policyHash;
      turnStore.setDirty(root, hash, "codex", "turn-1");
      turnStore.validationComplete(
        root,
        {
          schemaVersion: 1,
          repositoryHash: hash,
          policyHash,
          result: "REJECT",
          checks: [],
          timestamp: new Date().toISOString(),
          gateVersion: hash,
          gateMode: "full",
          gateFast: false,
        },
        "codex",
        "turn-1",
      );
      expect(turnStore.getState(root)).toMatchObject({ dirty: true, status: "REJECT" });

      turnStore.validationComplete(
        root,
        {
          schemaVersion: 1,
          repositoryHash: hash,
          policyHash,
          result: "PASS",
          checks: [],
          timestamp: new Date().toISOString(),
          gateVersion: hash,
          gateMode: "full",
          gateFast: false,
        },
        "codex",
        "turn-1",
      );
      expect(turnStore.getState(root)).toMatchObject({
        dirty: false,
        status: "VALIDATED_COMPLETE",
        validatedHash: hash,
      });
      expect(
        turnStore.listEvents(root).some((event) => event.type === "VALIDATED_COMPLETE" && event.host === "codex"),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows unconfigured repositories without creating gate state", async () => {
    const root = tempRepo(false);
    try {
      await expect(renderHookDecision("codex", { cwd: root, turn_id: "turn-1" })).resolves.toEqual({});
      expect(fs.existsSync(path.join(root, ".quality", "turn-state.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks three times before exhausting the retry budget", async () => {
    const root = tempRepo();
    try {
      const payload = { cwd: root, turn_id: "turn-1" };
      await expect(renderHookDecision("codex", payload)).resolves.toMatchObject({ decision: "block" });
      await expect(renderHookDecision("codex", payload)).resolves.toMatchObject({ decision: "block" });
      await expect(renderHookDecision("codex", payload)).resolves.toMatchObject({ decision: "block" });
      await expect(renderHookDecision("codex", payload)).resolves.toMatchObject({ decision: "error" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows deterministic PASS while retaining a current advisory provider failure", async () => {
    const root = tempRepo();
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: turn-test\nreview:\n  agentsmith: true\n",
      );
      const hash = computeWorkspaceVersion(root);
      const resolved = resolveConfig({ cwd: root });
      const policy = resolvePolicyForConfig(resolved);
      const workspaceSet = resolveWorkspaceSet(root, resolved.config.application);
      const runtime = engineRuntimeIdentity();
      const gate: GateResult = {
        schemaVersion: 2,
        version: hash,
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
        createdBy: {
          tool: "quality_run",
          adapter: "cli",
          engineVersion: ENGINE_VERSION,
          enginePath: runtime.executablePath,
          enginePackageRoot: runtime.packageRoot,
        },
        workspaces: workspaceSet.workspaces,
        workspaceHash: workspaceSet.workspaceHash,
        policy,
        toolVersions: currentToolVersions(workspaceSet.workspaces, policy),
      };
      writeGateResult(root, gate);
      fs.writeFileSync(
        path.join(root, ".quality", "review-result.yaml"),
        JSON.stringify({
          schemaVersion: 3,
          version: hash,
          status: "partial",
          outcome: "incomplete",
          mode: "partitioned",
          reviewPath: "generic",
          reviewer: "AgentSmith",
          timestamp: new Date().toISOString(),
          findings: [],
          coverage: {
            changedFiles: 0,
            changedFilesReviewed: 0,
            changedSymbols: 0,
            changedSymbolsReviewed: 0,
            localUnitsGenerated: 0,
            localUnitsReviewed: 0,
            interactionUnitsGenerated: 0,
            interactionUnitsReviewed: 0,
            dependencyEdgesIdentified: 0,
            dependencyEdgesEligible: 0,
            dependencyEdgesReviewed: 0,
            evidenceRequests: 0,
            evidenceResolved: 0,
            evidenceGaps: 0,
            globalScan: "none",
            omissions: [],
          },
          summary: "Provider timed out.",
          errors: ["provider timeout"],
          profileHash: policy.agentSmith.hash,
        }),
      );

      await expect(renderHookDecision("codex", { cwd: root, turn_id: "turn-1" })).resolves.toEqual({});
      expect(turnStore.getState(root)).toMatchObject({
        dirty: false,
        status: "VALIDATED_COMPLETE",
        validatedHash: hash,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
