import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { evaluateCompletion, getQualityStatus } from "../src/core/status.js";
import { computeWorkspaceVersion } from "../src/core/version.js";
import { writeGateResult } from "../src/core/gate-store.js";
import { renderHookDecision, resolveHookRoot } from "../src/hooks/runner.js";
import { createMatrixCoreMcpServer } from "../src/mcp/server.js";
import { executeQualityTool } from "../src/mcp/tools.js";
import type { GateResult } from "../src/core/types.js";
import { resolveWorkspaceSet } from "../src/core/workspace.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";
import { ENGINE_VERSION } from "../src/core/meta.js";
import { engineRuntimeIdentity } from "../src/core/runtime.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function tempProject(configured = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-universal-"));
  if (configured)
    fs.writeFileSync(
      path.join(dir, "quality.yaml"),
      "version: 2\nproject: universal-test\nreview:\n  agentsmith: false\n",
    );
  fs.writeFileSync(path.join(dir, ".gitignore"), ".quality/\n");
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  if (hasGit) spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function passingGate(dir: string, over: Partial<GateResult> = {}): GateResult {
  const workspaceSet = resolveWorkspaceSet(dir);
  const runtime = engineRuntimeIdentity();
  return {
    schemaVersion: 2,
    version: computeWorkspaceVersion(dir),
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
      adapter: "mcp",
      engineVersion: ENGINE_VERSION,
      enginePath: runtime.executablePath,
      enginePackageRoot: runtime.packageRoot,
    },
    workspaces: workspaceSet.workspaces,
    workspaceHash: workspaceSet.workspaceHash,
    policy: resolvePolicy(),
    toolVersions: {},
    ...over,
  };
}

function writeReview(dir: string, status: "completed" | "partial" | "error" | "stale" = "completed") {
  fs.mkdirSync(path.join(dir, ".quality"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".quality", "review-result.yaml"),
    yaml.dump({
      schemaVersion: 2,
      version: computeWorkspaceVersion(dir),
      status,
      outcome: status === "completed" ? "clear" : "incomplete",
      mode: "partitioned",
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
      summary: status === "completed" ? "No verified findings." : "Incomplete.",
      errors: status === "error" ? ["provider offline"] : [],
      profileHash: resolvePolicy().agentSmith.hash,
    }),
  );
}

describe("universal MatrixCore integration", () => {
  it("ships host manifests that resolve the same local package without downloads", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifests = [
      "plugins/matrix-core/.mcp.json",
      "integrations/claude-code/matrix-core/.mcp.json",
      "integrations/cline/cline_mcp_settings.fragment.json",
    ];
    for (const relative of manifests) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
      expect(manifest.mcpServers.matrixcore.command).toBe("npx");
      expect(manifest.mcpServers.matrixcore.args).toEqual(["--no-install", "matrixcore-mcp"]);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("@epv44/matrixcore");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.dependencies?.["@cline/sdk"]).toBeUndefined();
    expect(pkg.peerDependencies?.["@cline/sdk"]).toBeUndefined();
    expect(pkg.bin).toMatchObject({
      "matrixcore-mcp": "dist/mcp/server.js",
      "matrixcore-hook": "dist/hooks/runner.js",
    });
  });

  it.runIf(process.platform !== "win32")("builds executable package entrypoints", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "copy-assets.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const relative of new Set<string>(Object.values(pkg.bin))) {
      expect(fs.statSync(path.resolve(root, relative)).mode & 0o111, relative).not.toBe(0);
    }
  });

  it("leaves unconfigured repositories unaffected", () => {
    const dir = tempProject(false);
    try {
      expect(getQualityStatus(dir)).toMatchObject({ configured: false, completionAllowed: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("requires a current deterministic PASS", () => {
    const dir = tempProject();
    try {
      expect(evaluateCompletion(dir).completionAllowed).toBe(false);
      writeGateResult(dir, passingGate(dir));
      expect(evaluateCompletion(dir).completionAllowed).toBe(true);
      fs.writeFileSync(path.join(dir, "file.txt"), "two\n");
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false });
      expect(evaluateCompletion(dir).reason).toContain("workspaceVersion");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("never treats changed or fast evidence as completion", () => {
    const dir = tempProject();
    try {
      writeGateResult(
        dir,
        passingGate(dir, {
          mode: "changed",
          fast: true,
          changedFilesHash: "a".repeat(64),
          changedFileCount: 1,
        }),
      );
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false, gate: null });
      expect(evaluateCompletion(dir).changedGate?.mode).toBe("changed");

      fs.mkdirSync(path.join(dir, ".quality"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".quality", "completion-gate.json"),
        JSON.stringify(passingGate(dir, { mode: "full", fast: true })),
      );
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false });
      expect(evaluateCompletion(dir).reason).toContain("full, non-fast");

      writeGateResult(dir, passingGate(dir));
      expect(evaluateCompletion(dir).completionAllowed).toBe(true);
      writeGateResult(dir, passingGate(dir, { mode: "changed", status: "FAIL" }));
      expect(evaluateCompletion(dir).completionAllowed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("rejects legacy ambiguous gate evidence with migration guidance", () => {
    const dir = tempProject();
    try {
      fs.mkdirSync(path.join(dir, ".quality"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".quality", "gate-result.json"), JSON.stringify({ status: "PASS" }));
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false, gate: null });
      expect(evaluateCompletion(dir).reason).toContain("Legacy gate evidence");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("invalidates a PASS recorded for a different central policy", () => {
    const dir = tempProject();
    try {
      const stale = passingGate(dir);
      stale.policy = { ...stale.policy, policyHash: "0".repeat(64) };
      writeGateResult(dir, stale);
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false });
      expect(evaluateCompletion(dir).reason).toContain("policyHash");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("requires a current review attempt only when the project enables AgentSmith", () => {
    const dir = tempProject();
    try {
      fs.writeFileSync(
        path.join(dir, "quality.yaml"),
        "version: 2\nproject: universal-test\nreview:\n  agentsmith: true\n",
      );
      writeGateResult(dir, passingGate(dir));
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false, reviewRequired: true });
      expect(evaluateCompletion(dir).reason).toContain("missing or stale");

      writeReview(dir, "completed");
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: true, reviewRequired: true });
      writeReview(dir, "error");
      expect(evaluateCompletion(dir)).toMatchObject({ completionAllowed: false, reviewRequired: true });
      expect(evaluateCompletion(dir).reason).toContain("did not complete successfully");
      writeReview(dir, "stale");
      expect(evaluateCompletion(dir).completionAllowed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes native hook roots and response envelopes", () => {
    const dir = tempProject();
    try {
      expect(resolveHookRoot("cline", { workspaceRoots: [dir] })).toBe(fs.realpathSync(dir));
      expect(resolveHookRoot("codex", { cwd: dir })).toBe(fs.realpathSync(dir));
      expect(resolveHookRoot("claude", { cwd: dir })).toBe(fs.realpathSync(dir));
      expect(renderHookDecision("cline", { workspaceRoots: [dir] })).toMatchObject({ cancel: true });
      expect(renderHookDecision("codex", { cwd: dir })).toMatchObject({ decision: "block" });
      expect(renderHookDecision("claude", { cwd: dir })).toMatchObject({ decision: "block" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not enforce the completion gate for native Plan-mode enum representations", () => {
    expect(renderHookDecision("codex", { permission_mode: "plan" })).toEqual({});
    expect(renderHookDecision("codex", { permission_mode: "Plan" })).toEqual({});
    expect(renderHookDecision("codex", { permission_mode: " PLAN " })).toEqual({});
    expect(renderHookDecision("claude", { permission_mode: "Plan" })).toEqual({});
    expect(renderHookDecision("cline", { permission_mode: "Plan" })).toEqual({
      cancel: false,
      contextModification: "",
      errorMessage: "",
    });
    expect(renderHookDecision("codex", { permission_mode: "default" })).toMatchObject({ decision: "block" });
  });

  it("uses the matching Codex transcript turn to detect conversational Plan mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-hook-transcript-"));
    const transcript = path.join(dir, "rollout.jsonl");
    try {
      const records = [
        {
          type: "event_msg",
          payload: { type: "task_started", turn_id: "old-turn", collaboration_mode_kind: "plan" },
        },
        {
          type: "event_msg",
          payload: { type: "task_started", turn_id: "current-turn", collaboration_mode_kind: "plan" },
        },
      ];
      fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n{not-json\n`);

      expect(
        renderHookDecision("codex", {
          permission_mode: "default",
          transcript_path: transcript,
          turn_id: "current-turn",
        }),
      ).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let an older Codex Plan turn bypass the current Default turn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-hook-transcript-"));
    const transcript = path.join(dir, "rollout.jsonl");
    try {
      const records = [
        {
          type: "event_msg",
          payload: { type: "task_started", turn_id: "current-turn", collaboration_mode_kind: "plan" },
        },
        {
          type: "event_msg",
          payload: { type: "task_started", turn_id: "current-turn", collaboration_mode_kind: "default" },
        },
      ];
      fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

      expect(
        renderHookDecision("codex", {
          permission_mode: "default",
          transcript_path: transcript,
          turn_id: "current-turn",
        }),
      ).toMatchObject({ decision: "block" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps transcript fallback Codex-only and fails closed for unusable transcript evidence", () => {
    const payload = {
      permission_mode: "default",
      collaboration_mode_kind: "plan",
      transcript_path: "/does/not/exist",
      turn_id: "turn",
    };
    expect(renderHookDecision("codex", payload)).toEqual({});
    expect(renderHookDecision("claude", payload)).toMatchObject({ decision: "block" });
    expect(renderHookDecision("cline", payload)).toMatchObject({ cancel: true });
    expect(
      renderHookDecision("codex", {
        permission_mode: "default",
        transcript_path: "/does/not/exist",
        turn_id: "turn",
      }),
    ).toMatchObject({ decision: "block" });
  });

  it("fails closed when a configured hook payload cannot resolve its workspace", () => {
    expect(renderHookDecision("codex", {})).toMatchObject({ decision: "block" });
    expect(renderHookDecision("cline", {})).toMatchObject({ cancel: true });
  });

  it("constructs the MCP server and exposes status through the shared tool service", async () => {
    const dir = tempProject(false);
    try {
      expect(createMatrixCoreMcpServer()).toBeDefined();
      await expect(executeQualityTool("quality_status", { root: dir })).resolves.toMatchObject({
        configured: false,
        completionAllowed: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes identical workspace and policy hashes through gates, MCP status, and hooks", async () => {
    const dir = tempProject();
    try {
      const gate = (await executeQualityTool("quality_run", { root: dir, mode: "full" })) as GateResult;
      const status = (await executeQualityTool("quality_status", { root: dir })) as ReturnType<typeof getQualityStatus>;
      expect(status.policy?.policyHash).toBe(gate.policy?.policyHash);
      expect(status.workspaces?.map((workspace) => workspace.resolutionHash)).toEqual(
        gate.workspaces?.map((workspace) => workspace.resolutionHash),
      );
      fs.writeFileSync(path.join(dir, "file.txt"), "changed\n");
      expect(renderHookDecision("codex", { cwd: dir })).toMatchObject({
        decision: "block",
        reason: expect.stringContaining(`policy=${status.policy?.policyHash}`),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasGit)("quality_fix prepares work for the active host without invoking a reviewer", async () => {
    const dir = tempProject();
    try {
      const version = computeWorkspaceVersion(dir);
      fs.mkdirSync(path.join(dir, ".quality"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".quality", "review-result.yaml"),
        yaml.dump({
          schemaVersion: 2,
          version,
          status: "completed",
          outcome: "findings",
          mode: "partitioned",
          reviewer: "AgentSmith",
          timestamp: new Date().toISOString(),
          coverage: {
            changedFiles: 1,
            changedFilesReviewed: 1,
            changedSymbols: 0,
            changedSymbolsReviewed: 0,
            localUnitsGenerated: 1,
            localUnitsReviewed: 1,
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
          summary: "1 verified finding.",
          findings: [
            {
              id: "f-1",
              severity: "high",
              category: "correctness",
              title: "bug",
              description: "bug",
              file: "file.txt",
              line: 1,
              confidence: "verified",
              evidence: [],
              sourceWorkItemIds: ["local"],
            },
          ],
        }),
      );
      const task = (await executeQualityTool("quality_fix", {
        root: dir,
        review_version: version,
        finding_ids: ["f-1"],
      })) as { status: string; instructions: string[] };
      expect(task.status).toBe("READY");
      expect(task.instructions.join(" ")).toContain("active host model");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
