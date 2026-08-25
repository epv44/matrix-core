import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAgentSmithTraceEnabled,
  listAgentSmithTraces,
  pruneAgentSmithTraces,
  readAgentSmithTrace,
  readTraceSourceManifest,
  traceStatus,
  writeAgentSmithTrace,
  type AgentSmithTrace,
} from "../../src/agentsmith/trace.js";
import { captureSourceSnapshot, sourceObjectPath } from "../../src/agentsmith/source-snapshot.js";
import { computeWorkspaceVersion } from "../../src/core/version.js";

const originalTraceSetting = process.env.MATRIXCORE_TRACE;

afterEach(() => {
  if (originalTraceSetting === undefined) delete process.env.MATRIXCORE_TRACE;
  else process.env.MATRIXCORE_TRACE = originalTraceSetting;
});

function input() {
  const scope = {
    id: "scope",
    version: "workspace-version",
    root: process.cwd(),
    base: "main",
    diff: "+change",
    changedFiles: ["a.ts"],
    fileContents: { "a.ts": "change\n" },
    suppliedContext: {},
    manifest: [
      {
        path: "a.ts",
        changeKind: "modified" as const,
        additions: 1,
        deletions: 0,
        language: "typescript",
        generated: false,
        binary: false,
      },
    ],
    omissions: [],
    languages: ["typescript"],
    metadata: { fileCount: 1, additions: 1, deletions: 0, capturedAt: "now" },
  };
  return {
    packageVersion: "test",
    version: "workspace-version",
    scope,
    deterministicReport: "PASS",
    result: {
      schemaVersion: 3 as const,
      version: "workspace-version",
      status: "completed" as const,
      outcome: "clear" as const,
      mode: "partitioned" as const,
      reviewPath: "generic" as const,
      findings: [],
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
        globalScan: "none" as const,
        omissions: [],
      },
      summary: "No verified findings.",
      timestamp: "2026-08-14T00:00:00.000Z",
      reviewer: "AgentSmith",
    },
    decisionProvenance: {
      publishedFindingIds: [],
      rejectedCandidateIds: [],
      likelyCandidateIds: [],
      insufficientEvidenceCandidateIds: [],
      aggregateRule: "none",
      errors: [],
    },
  };
}

describe("AgentSmith local traces", () => {
  it("captures a complete content-addressed repository source snapshot", () => {
    process.env.MATRIXCORE_TRACE = "agentsmith";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-source-"));
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: trace-source\nreview:\n  agentsmith: true\n",
    );
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const tracked = 1;\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, "deleted.ts"), "export const removed = true;\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "-A"], { cwd: root }).status).toBe(0);
    fs.unlinkSync(path.join(root, "deleted.ts"));
    fs.writeFileSync(path.join(root, "untracked.ts"), "export const newValue = 2;\n");
    fs.symlinkSync("tracked.ts", path.join(root, "tracked-link.ts"));
    const version = computeWorkspaceVersion(root);
    const captured = captureSourceSnapshot(root, version);
    expect(captured).toMatchObject({ complete: true, portable: true, fileCount: 4 });
    const written = writeAgentSmithTrace(root, { ...input(), version, sourceSnapshotCapture: captured });
    const trace = readAgentSmithTrace(root, written.traceId!);
    expect(trace).toMatchObject({ schemaVersion: 5, sourceSnapshot: { complete: true, portable: true } });
    const manifest = readTraceSourceManifest(root, written.traceId!);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "quality.yaml",
      "tracked-link.ts",
      "tracked.ts",
      "untracked.ts",
    ]);
    expect(manifest.deletedPaths).toEqual(["deleted.ts"]);
    const tracked = manifest.entries.find((entry) => entry.path === "tracked.ts")!;
    expect(tracked.executable).toBe(true);
    expect(fs.readFileSync(sourceObjectPath(root, tracked.sha256), "utf8")).toContain("tracked = 1");
  });

  it("marks source snapshots with escaping symlinks as nonportable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-symlink-"));
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: symlink\nreview:\n  agentsmith: true\n");
    fs.symlinkSync("../outside", path.join(root, "outside-link"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    const version = computeWorkspaceVersion(root);
    expect(captureSourceSnapshot(root, version)).toMatchObject({
      complete: true,
      portable: false,
      warnings: [expect.stringContaining("nonportable symlink")],
    });
  });

  it("captures bounded local traces by default", () => {
    delete process.env.MATRIXCORE_TRACE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-auto-"));
    expect(isAgentSmithTraceEnabled()).toBe(true);
    const written = writeAgentSmithTrace(root, input());
    expect(readAgentSmithTrace(root, written.traceId!)).toMatchObject({ captureMode: "automatic-local" });
  });

  it("can be disabled explicitly", () => {
    process.env.MATRIXCORE_TRACE = "off";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-off-"));
    expect(isAgentSmithTraceEnabled()).toBe(false);
    expect(writeAgentSmithTrace(root, input())).toEqual({});
    expect(listAgentSmithTraces(root)).toEqual([]);
  });

  it("requires explicit activation and writes a private atomic trace", () => {
    process.env.MATRIXCORE_TRACE = "agentsmith";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-on-"));
    const written = writeAgentSmithTrace(root, input());
    expect(written.traceId).toBeTruthy();
    const trace = readAgentSmithTrace(root, written.traceId!);
    expect(trace).toMatchObject({ captureMode: "explicit-local", packageVersion: "test" });
    expect(listAgentSmithTraces(root)).toHaveLength(1);
    expect(traceStatus(root)).toMatchObject({ enabled: true, uploadCapability: false, traceCount: 1 });
    const mode = fs.statSync(path.join(root, ".quality", "traces", "agentsmith", written.traceId!, "trace.json")).mode;
    expect(mode & 0o077).toBe(0);
  });

  it("retains exact failed provider output only in an explicitly enabled trace", () => {
    process.env.MATRIXCORE_TRACE = "agentsmith";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-provider-failure-"));
    const raw = '{"summary":"cut","candidates":[{"description":"unfinished';
    const execution = {
      providerFailures: [
        {
          sourceId: "interaction:test",
          outputKind: "candidates",
          prompt: "review this change",
          raw,
          usage: { inputTokens: 12, outputTokens: 4096 },
          completion: {
            model: "qwen3.5:9b-q4_K_M",
            done: true,
            doneReason: "length",
            totalDurationNs: 64_000_000_000,
            loadDurationNs: 1,
            promptEvalDurationNs: 2,
            evalDurationNs: 3,
          },
          parseError: "Unterminated string in JSON at position 58",
          parsePosition: 58,
          parseContext: raw,
        },
      ],
    } as unknown as NonNullable<AgentSmithTrace["execution"]>;
    const written = writeAgentSmithTrace(root, { ...input(), execution });
    const trace = readAgentSmithTrace(root, written.traceId!);
    expect(trace.execution?.providerFailures?.[0]).toMatchObject({
      raw,
      completion: { doneReason: "length" },
    });
  });

  it("prunes oldest traces by count while retaining the newest", () => {
    delete process.env.MATRIXCORE_TRACE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-retention-"));
    const ids = Array.from({ length: 3 }, (_, index) => {
      const traceId = writeAgentSmithTrace(root, input()).traceId!;
      const modified = new Date(1_700_000_000_000 + index * 1000);
      fs.utimesSync(path.join(root, ".quality", "traces", "agentsmith", traceId), modified, modified);
      return traceId;
    });
    const pruned = pruneAgentSmithTraces(root, { maxCount: 2, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(pruned).toMatchObject({ retained: 2 });
    expect(pruned.removed).toHaveLength(1);
    expect(listAgentSmithTraces(root)).toHaveLength(2);
    expect(listAgentSmithTraces(root).map((trace) => trace.traceId)).toContain(ids[2]);
  });

  it("retains shared source objects until the last referencing trace is pruned", () => {
    process.env.MATRIXCORE_TRACE = "agentsmith";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-trace-cas-retention-"));
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: retention\nreview:\n  agentsmith: true\n");
    fs.writeFileSync(path.join(root, "shared.ts"), "export const shared = true;\n");
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "-A"], { cwd: root });
    const version = computeWorkspaceVersion(root);
    const captured = captureSourceSnapshot(root, version);
    const digest = captured.manifest.entries.find((entry) => entry.path === "shared.ts")!.sha256;
    const first = writeAgentSmithTrace(root, { ...input(), version, sourceSnapshotCapture: captured }).traceId!;
    const second = writeAgentSmithTrace(root, { ...input(), version, sourceSnapshotCapture: captured }).traceId!;
    fs.utimesSync(path.join(root, ".quality", "traces", "agentsmith", first), new Date(1), new Date(1));
    fs.utimesSync(path.join(root, ".quality", "traces", "agentsmith", second), new Date(2), new Date(2));
    pruneAgentSmithTraces(root, { maxCount: 1, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(fs.existsSync(sourceObjectPath(root, digest))).toBe(true);
    expect(listAgentSmithTraces(root)).toHaveLength(1);
  });

  it("rejects unsafe trace ids", () => {
    expect(() => readAgentSmithTrace(process.cwd(), "../escape")).toThrow(/Invalid trace id/);
  });
});
