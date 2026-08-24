import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAgentSmithTraceEnabled,
  listAgentSmithTraces,
  pruneAgentSmithTraces,
  readAgentSmithTrace,
  traceStatus,
  writeAgentSmithTrace,
  type AgentSmithTrace,
} from "../../src/agentsmith/trace.js";

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

  it("rejects unsafe trace ids", () => {
    expect(() => readAgentSmithTrace(process.cwd(), "../escape")).toThrow(/Invalid trace id/);
  });
});
