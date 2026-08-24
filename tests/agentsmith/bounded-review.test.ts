import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { captureReviewScope } from "../../src/agentsmith/scope.js";
import { executeReviewEngine } from "../../src/agentsmith/engine.js";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";
import { runQualityCompletion } from "../../src/core/review.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { AgentSmithConfig, ReviewCoverage, ReviewResult } from "../../src/core/types.js";

type CallKind = "candidates" | "specialist" | "scout" | "verification";

interface ProviderHarness {
  provider: ReviewProvider;
  calls: CallKind[];
  candidatePrompts: string[];
  candidateLimits: Array<number | undefined>;
  maxActive: number;
  invokedAfterAbort: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForAbort = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (!signal || signal.aborted) reject(signal?.reason ?? new Error("aborted"));
    else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
function makeProvider(opts: {
  candidatesPerCall?: number;
  holisticCandidates?: number;
  candidateDelayMs?: number;
  verificationDelayMs?: number;
  blockCandidates?: boolean;
  blockVerification?: boolean;
  blockScout?: boolean;
  firstVerificationVerified?: boolean;
  scoutHotspots?: unknown[];
  malformedCandidate?: boolean;
  failSpecialist?: string;
}): ProviderHarness {
  const calls: CallKind[] = [];
  const state: ProviderHarness = {
    provider: null as never,
    calls,
    candidatePrompts: [],
    candidateLimits: [],
    maxActive: 0,
    invokedAfterAbort: 0,
  };
  let candidateCall = 0;
  let verificationCall = 0;
  let active = 0;
  const fileFromPrompt = (prompt: string) => /--- ([^:\s]+):/.exec(prompt)?.[1] ?? "unknown.ts";
  function candidatePayload(file: string, index: number) {
    return {
      f: file,
      l: 1,
      s: "high" as const,
      k: "correctness" as const,
      t: `Probe defect ${index}`,
      d: `Changed value at ${file} causes a concrete failure for probe index ${index}.`,
      g: "Guard the value.",
      q: 0.9,
      e: [],
    };
  }
  state.provider = {
    health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M", "qwen3.5:122b-a10b"] }),
    invoke: async (input) => {
      calls.push(input.outputKind);
      if (input.signal?.aborted) state.invokedAfterAbort++;
      active++;
      state.maxActive = Math.max(state.maxActive, active);
      try {
        if (input.outputKind === "scout") {
          if (opts.blockScout) await waitForAbort(input.signal);
          if (opts.candidateDelayMs) await delay(opts.candidateDelayMs);
          return {
            raw: JSON.stringify({ hotspots: opts.scoutHotspots ?? [] }),
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (input.outputKind === "verification") {
          if (opts.verificationDelayMs) await delay(opts.verificationDelayMs);
          if (opts.blockVerification) await waitForAbort(input.signal);
          if (opts.firstVerificationVerified && verificationCall++ > 0) await waitForAbort(input.signal);
          return {
            raw: '{"verdict":"verified","confidence":1,"supportingEvidenceIds":[]}',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        if (opts.blockCandidates) await waitForAbort(input.signal);
        if (input.outputKind === "specialist" && opts.failSpecialist && input.prompt.includes(opts.failSpecialist))
          throw new Error("specialist provider failure");
        state.candidatePrompts.push(input.prompt);
        state.candidateLimits.push(input.maxCandidates);
        if (opts.candidateDelayMs) await delay(opts.candidateDelayMs);
        if (opts.malformedCandidate)
          return {
            raw: '{"c":[{"d":"unfinished',
            usage: { inputTokens: 12, outputTokens: 4096 },
            completion: {
              model: "qwen3.5:9b-q4_K_M",
              done: true,
              doneReason: "length",
              totalDurationNs: 64_000_000_000,
              loadDurationNs: 1_000_000,
              promptEvalDurationNs: 2_000_000,
              evalDurationNs: 63_000_000_000,
            },
          };
        const file = fileFromPrompt(input.prompt);
        const count = Math.min(
          input.maxCandidates ?? Number.POSITIVE_INFINITY,
          opts.holisticCandidates ?? opts.candidatesPerCall ?? 1,
        );
        const candidates = Array.from({ length: count }, (_, index) =>
          candidatePayload(file, candidateCall * 100 + index),
        );
        candidateCall++;
        return {
          raw: JSON.stringify({
            ...(input.outputKind === "specialist" ? { summary: "Specialist summary." } : {}),
            c: candidates,
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      } finally {
        active--;
      }
    },
  };
  return state;
}

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function setupRepo(root: string, files: number) {
  fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: bounded\nreview:\n  agentsmith: true\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bounded", private: true }));
  fs.writeFileSync(path.join(root, ".agentignore"), "node_modules/\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "x@y.z");
  git(root, "config", "user.name", "x");
  for (let index = 0; index < files; index++)
    fs.writeFileSync(path.join(root, `f${index}.ts`), `export function f${index}(): number { return 0; }\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  for (let index = 0; index < files; index++)
    fs.writeFileSync(path.join(root, `f${index}.ts`), `export function f${index}(): number { return ${index + 1}; }\n`);
}

async function runEngine(opts: {
  files: number;
  harness: ProviderHarness;
  configure?: (config: AgentSmithConfig) => void;
  deterministicReport?: string;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-bounded-"));
  try {
    setupRepo(root, opts.files);
    const scope = captureReviewScope({ root, base: "HEAD" });
    const config = agentSmithConfigFromPolicy(true);
    config.cache = false;
    opts.configure?.(config);
    const { result, execution } = await executeReviewEngine({
      root,
      version: scope.version,
      scope,
      config,
      provider: opts.harness.provider,
      deterministicReport: opts.deterministicReport,
      enforceWorkspaceVersion: false,
    });
    return { result, execution };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function omissionsByReason(coverage: ReviewCoverage, reason: string) {
  return coverage.omissions.filter((item) => item.reason === reason);
}

function verifyResultShape(result: ReviewResult) {
  expect(result.schemaVersion).toBe(3);
  expect(result.coverage.callsStarted ?? 0).toBeGreaterThanOrEqual(0);
  expect(result.coverage.callsCompleted ?? 0).toBeGreaterThanOrEqual(0);
  expect(result.coverage.callsCancelled ?? 0).toBeGreaterThanOrEqual(0);
  expect(result.coverage.selectedWorkItems ?? 0).toBeGreaterThanOrEqual(0);
  expect(result.coverage.omittedWorkItems ?? 0).toBeGreaterThanOrEqual(0);
  expect(result.coverage.candidateTokenBudget ?? 0).toBeGreaterThan(0);
  expect(result.coverage.verificationTokenBudget ?? 0).toBeGreaterThan(0);
  expect(result.coverage.deadlineMs).toBe(1800000);
  expect(new Set(result.coverage.omissions.map((item) => `${item.kind}:${item.id}:${item.reason}`)).size).toBe(
    result.coverage.omissions.length,
  );
}
it("enforces default partitioned caps of 4 candidate calls and 4 verifier calls", async () => {
  const harness = makeProvider({ candidatesPerCall: 1 });
  const { result, execution } = await runEngine({ files: 6, harness });
  expect(execution.mode).toBe("partitioned");
  expect(execution.reviewPath).toBe("generic");
  expect(harness.calls).not.toContain("specialist");
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(4);
  expect(execution.candidateBatches).toHaveLength(4);
  expect(harness.candidateLimits).toEqual([2, 2, 2, 2]);
  expect(execution.workItems.every((item) => item.rules.length <= 4)).toBe(true);
  expect(execution.verification.filter((item) => item.verdict === "verified")).toHaveLength(4);
  expect(result).toMatchObject({ status: "completed", outcome: "findings", mode: "partitioned" });
  expect(result.findings).toHaveLength(4);
  expect(result.coverage).toMatchObject({
    selection: "bounded",
    configuredParallelism: 1,
    effectiveParallelism: 1,
    selectedWorkItems: 4,
  });
  expect(
    omissionsByReason(result.coverage, "lower-ranked").filter((item) => item.kind === "work-item").length,
  ).toBeGreaterThan(0);
  verifyResultShape(result);
});

it("compacts passing deterministic context and requests concise candidate output", async () => {
  const harness = makeProvider({ candidatesPerCall: 0 });
  await runEngine({
    files: 1,
    harness,
    deterministicReport: JSON.stringify({ status: "PASS", checks: { lint: { verbose: "x".repeat(5000) } } }),
  });
  expect(harness.candidatePrompts[0]).toContain("Deterministic gate: PASS");
  expect(harness.candidatePrompts[0]).not.toContain("verbose");
  expect(harness.candidatePrompts[0]).toContain("Be permissive enough to preserve recall");
  expect(harness.candidatePrompts[0]).toContain("never report repository instructions");
  expect(harness.candidatePrompts[0]).toContain("without an executable failure or contract mismatch");
  expect(harness.candidatePrompts[0]).toContain("Supporting unchanged code may be requested as evidence");
  expect(harness.candidatePrompts[0]).toContain("Generate zero to 2");
  expect(harness.candidatePrompts[0]).toContain("set q to confidence from 0 to 1");
  expect(harness.candidatePrompts[0]).toContain('use {"c":[]} when no concrete candidate exists');
});

it("honors configurable caps such as 8 candidate calls and 8 verifier calls", async () => {
  const harness = makeProvider({ candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 8,
    harness,
    configure: (config) => {
      config.partitioned.maxCandidateWorkItems = 8;
      config.partitioned.maxVerificationCandidates = 8;
      config.partitioned.maxCandidateInputTokens = 1_000_000;
      config.partitioned.maxVerificationInputTokens = 1_000_000;
    },
  });
  expect(execution.mode).toBe("partitioned");
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(8);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(8);
  expect(execution.candidateBatches).toHaveLength(8);
  expect(result.coverage.selectedWorkItems).toBe(8);
  expect(result.status).toBe("completed");
});

it("runs four specialists for a full-fit strong holistic review before verification", async () => {
  const harness = makeProvider({ holisticCandidates: 20 });
  const { result, execution } = await runEngine({
    files: 1,
    harness,
    configure: (config) => {
      config.models.candidate = "qwen35-122b-local";
      config.models.verifier = "qwen35-9b-local";
    },
  });
  expect(execution.mode).toBe("holistic");
  expect(execution.reviewPath).toBe("specialist");
  expect(harness.calls.filter((kind) => kind === "specialist")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(0);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(4);
  expect(harness.calls).toHaveLength(8);
  expect(execution.candidates).toHaveLength(60);
  expect(result.reviewPath).toBe("specialist");
  expect(result.specialists?.map((item) => item.reviewer)).toEqual([
    "architecture-reviewer",
    "perf-reviewer",
    "bug-hunter",
    "semantic-reviewer",
  ]);
  expect(result.coverage.selectedWorkItems).toBe(0);
});

it("falls back to the generic bounded path when a strong profile cannot fit the full projection", async () => {
  const harness = makeProvider({ candidatesPerCall: 0 });
  const { result, execution } = await runEngine({
    files: 60,
    harness,
    configure: (config) => {
      config.models.candidate = "qwen35-122b-local";
      const strong = config.model_profiles.find((profile) => profile.id === "qwen35-122b-local")!;
      strong.contextTokens = 2048;
      strong.requestedOutputTokens = 512;
      strong.safetyReserveTokens = 256;
    },
  });
  expect(execution.mode).toBe("partitioned");
  expect(execution.reviewPath).toBe("generic");
  expect(harness.calls).not.toContain("specialist");
  expect(result.reviewPath).toBe("generic");
  expect(result.specialists).toBeUndefined();
});

it("preserves completed specialist narratives when one specialist fails", async () => {
  const harness = makeProvider({ candidatesPerCall: 0, failSpecialist: "# Performance reviewer" });
  const { result } = await runEngine({
    files: 1,
    harness,
    configure: (config) => {
      config.models.candidate = "qwen35-122b-local";
    },
  });
  expect(result).toMatchObject({ reviewPath: "specialist", status: "partial", outcome: "incomplete" });
  expect(result.specialists).toHaveLength(4);
  expect(result.specialists?.find((item) => item.reviewer === "perf-reviewer")).toMatchObject({
    status: "error",
    summary: "Specialist review did not complete.",
  });
  expect(result.specialists?.filter((item) => item.status === "completed")).toHaveLength(3);
});

it("creates targeted inspectors from hybrid scout output", async () => {
  const harness = makeProvider({
    candidatesPerCall: 1,
    scoutHotspots: [
      {
        hotspotId: "h1",
        risk: "high",
        category: "correctness",
        symbols: ["f1"],
        edges: [],
        rationale: "changed return value",
        requestedInspection: { symbols: ["f1"], edgeKinds: [] },
      },
    ],
  });
  const { execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.models.scout = "qwen35-122b-local";
    },
  });
  expect(execution.mode).toBe("hybrid");
  expect(execution.workItems.length).toBeGreaterThanOrEqual(1);
  expect(execution.workItems.every((item) => item.primarySymbols.every((symbol) => symbol.name === "f1"))).toBe(true);
  expect(harness.calls.filter((kind) => kind === "candidates").length).toBeLessThanOrEqual(4);
});

it("falls back to full risk-ranked work when scout output is empty", async () => {
  const harness = makeProvider({ candidatesPerCall: 1, scoutHotspots: [] });
  const { execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.models.scout = "qwen35-122b-local";
    },
  });
  expect(execution.mode).toBe("hybrid");
  expect(execution.workItems.length).toBe(4);
  const symbols = new Set(execution.workItems.flatMap((item) => item.primarySymbols.map((symbol) => symbol.name)));
  expect(symbols.size).toBeGreaterThanOrEqual(2);
});

it("omits work items that exceed the candidate token budget", async () => {
  const harness = makeProvider({ candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.partitioned.maxCandidateInputTokens = 100;
    },
  });
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(0);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(0);
  expect(execution.candidateBatches).toHaveLength(0);
  expect(
    omissionsByReason(result.coverage, "token-budget").filter((item) => item.kind === "work-item").length,
  ).toBeGreaterThan(0);
  expect(result.coverage.candidateTokensEstimated).toBe(0);
  expect(result.coverage.selection).toBe("bounded");
  expect(result.status).toBe("completed");
});

it("starts no candidate work after a timeout that fires during scouting", async () => {
  const harness = makeProvider({ blockScout: true, candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.models.scout = "qwen35-122b-local";
      config.maxDurationMs = 120;
    },
  });
  expect(execution.mode).toBe("hybrid");
  expect(harness.calls.filter((kind) => kind === "scout")).toHaveLength(1);
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(0);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(0);
  expect(harness.invokedAfterAbort).toBe(0);
  expect(result.status).toBe("partial");
  expect(result.outcome).toBe("incomplete");
  expect(result.coverage.timeout).toBeDefined();
  expect(result.coverage.timeout?.callsStarted).toBe(1);
  expect(result.coverage.timeout?.callsCancelled).toBe(1);
  expect(result.coverage.timeoutOmissions).toBeGreaterThan(0);
  expect(result.summary).toMatch(/timed out/);
});

it("stops starting calls after a timeout during candidate generation", async () => {
  const harness = makeProvider({ blockCandidates: true, candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.maxDurationMs = 120;
    },
  });
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(1);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(0);
  expect(result.status).toBe("partial");
  expect(result.coverage.timeout?.callsStarted).toBe(1);
  expect(result.coverage.timeout?.callsCancelled).toBe(1);
  expect(omissionsByReason(result.coverage, "timeout").filter((item) => item.kind === "work-item").length).toBe(4);
  expect(execution.verification).toHaveLength(0);
});

it("marks unfinished verification as timeout instead of verifier failure", async () => {
  const harness = makeProvider({ blockVerification: true, candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.maxDurationMs = 200;
    },
  });
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(1);
  expect(result.status).toBe("partial");
  expect(execution.verification).toHaveLength(0);
  expect(result.findings).toHaveLength(0);
  expect(result.errors).toHaveLength(0);
  expect(result.coverage.timeout?.callsStarted).toBe(5);
  expect(result.coverage.timeout?.callsCancelled).toBe(1);
  expect(omissionsByReason(result.coverage, "timeout").filter((item) => item.kind === "candidate").length).toBe(4);
  expect(result.summary).toMatch(/timed out/);
});

it("never exceeds configured parallelism for in-flight model calls", async () => {
  for (const parallelism of [1, 2, 4]) {
    const harness = makeProvider({ candidatesPerCall: 1, candidateDelayMs: 30, verificationDelayMs: 30 });
    const { result, execution } = await runEngine({
      files: 4,
      harness,
      configure: (config) => {
        config.concurrency = parallelism;
      },
    });
    expect(result.coverage.configuredParallelism).toBe(parallelism);
    expect(result.coverage.effectiveParallelism).toBe(parallelism);
    expect(harness.maxActive).toBeLessThanOrEqual(parallelism);
    expect(result.coverage.maxObservedConcurrency ?? 0).toBeLessThanOrEqual(parallelism);
    expect(execution.verification.filter((item) => item.verdict === "verified")).toHaveLength(4);
  }
});

it("selects identical work and preserves verification order across parallelism values", async () => {
  const runs = [];
  for (const parallelism of [1, 2, 4]) {
    const harness = makeProvider({ candidatesPerCall: 1 });
    const { result, execution } = await runEngine({
      files: 4,
      harness,
      configure: (config) => {
        config.concurrency = parallelism;
      },
    });
    runs.push({
      workItems: execution.workItems.map((item) => item.id),
      verification: execution.verification.map((item) => item.candidateId),
      coverage: {
        selectedWorkItems: result.coverage.selectedWorkItems,
        omittedWorkItems: result.coverage.omittedWorkItems,
        verificationTokensEstimated: result.coverage.verificationTokensEstimated,
        candidateTokensEstimated: result.coverage.candidateTokensEstimated,
      },
    });
  }
  expect(runs[0].workItems).toEqual(runs[1].workItems);
  expect(runs[0].workItems).toEqual(runs[2].workItems);
  expect(runs[0].verification).toEqual(runs[1].verification);
  expect(runs[0].verification).toEqual(runs[2].verification);
  expect(runs[0].coverage).toEqual(runs[1].coverage);
  expect(runs[0].coverage).toEqual(runs[2].coverage);
});

it("reports deterministic coverage accounting for a complete bounded review", async () => {
  const harness = makeProvider({ candidatesPerCall: 2 });
  const { result, execution } = await runEngine({ files: 6, harness });
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(4);
  expect(execution.candidates).toHaveLength(8);
  expect(result.coverage.selectedWorkItems).toBe(4);
  const workItemOmissions =
    omissionsByReason(result.coverage, "lower-ranked").filter((item) => item.kind === "work-item").length +
    omissionsByReason(result.coverage, "token-budget").filter((item) => item.kind === "work-item").length;
  expect(result.coverage.omittedWorkItems).toBe(workItemOmissions);
  expect(result.coverage.omittedWorkItems ?? 0).toBeGreaterThan(0);
  expect(result.coverage.timeoutOmissions).toBe(0);
  expect(result.coverage.candidateTokensEstimated ?? 0).toBeGreaterThan(0);
  expect(result.coverage.verificationTokensEstimated ?? 0).toBeGreaterThan(0);
  expect(result.coverage.callsCompleted).toBe(result.coverage.callsStarted);
  expect(result.coverage.callsCancelled).toBe(0);
  const verificationIds = execution.verification.map((item) => item.candidateId);
  expect(new Set(verificationIds).size).toBe(verificationIds.length);
});

it("retains exact malformed provider output and finish metadata for opt-in traces", async () => {
  const harness = makeProvider({ malformedCandidate: true });
  const { result, execution } = await runEngine({ files: 1, harness });
  expect(result.status).toBe("partial");
  expect(result.errors[0]).toContain("done_reason=length");
  expect(result.errors[0]).toContain("output_tokens=4096");
  expect(execution.providerFailures?.[0]).toMatchObject({
    outputKind: "candidates",
    raw: '{"c":[{"d":"unfinished',
    completion: { done: true, doneReason: "length" },
    usage: { inputTokens: 12, outputTokens: 4096 },
  });
  expect(execution.providerFailures?.[0].parseContext).toContain("unfinished");
});

it("preserves completed findings after a timeout during verification", async () => {
  const harness = makeProvider({ firstVerificationVerified: true, candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.maxDurationMs = 200;
    },
  });
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(2);
  expect(result.status).toBe("partial");
  expect(result.outcome).toBe("incomplete");
  expect(result.findings).toHaveLength(1);
  expect(execution.verification.filter((item) => item.verdict === "verified")).toHaveLength(1);
  expect(omissionsByReason(result.coverage, "timeout").filter((item) => item.kind === "candidate").length).toBe(3);
});

it("enforces the verification token budget independently", async () => {
  const harness = makeProvider({ candidatesPerCall: 1 });
  const { result, execution } = await runEngine({
    files: 4,
    harness,
    configure: (config) => {
      config.partitioned.maxVerificationInputTokens = 100;
    },
  });
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(0);
  expect(execution.verification).toHaveLength(0);
  expect(omissionsByReason(result.coverage, "token-budget").filter((item) => item.kind === "candidate").length).toBe(4);
  expect(result.coverage.verificationTokensEstimated).toBe(0);
  expect(result.coverage.tokenBudgetOmissions).toBe(4);
  expect(result.status).toBe("partial");
  expect(result.incompleteReasons).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "unadjudicated-candidate" })]),
  );
});

it("caps model calls in hybrid mode at scout plus 4 candidate and 4 verifier calls", async () => {
  const hotspots = Array.from({ length: 6 }, (_, index) => ({
    hotspotId: `h${index}`,
    risk: "high" as const,
    category: "correctness" as const,
    symbols: [`f${index}`],
    edges: [],
    rationale: "changed return value",
    requestedInspection: { symbols: [`f${index}`], edgeKinds: [] },
  }));
  const harness = makeProvider({ candidatesPerCall: 1, scoutHotspots: hotspots });
  const { result, execution } = await runEngine({
    files: 6,
    harness,
    configure: (config) => {
      config.models.scout = "qwen35-122b-local";
    },
  });
  expect(execution.mode).toBe("hybrid");
  expect(execution.scout?.hotspots).toHaveLength(6);
  expect(harness.calls.filter((kind) => kind === "scout")).toHaveLength(1);
  expect(harness.calls.filter((kind) => kind === "candidates")).toHaveLength(4);
  expect(harness.calls.filter((kind) => kind === "verification")).toHaveLength(4);
  expect(harness.calls).toHaveLength(9);
  expect(result.status).toBe("completed");
});

describe("bounded parallel review with timeout control", () => {
  it("preserves a timed-out partial review without blocking deterministic completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-bounded-completion-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: bounded-completion\nreview:\n  agentsmith: true\n  maxDurationMs: 1000\n",
      );
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bounded-completion", private: true }));
      git(root, "init", "-q");
      git(root, "config", "user.email", "x@y.z");
      git(root, "config", "user.name", "x");
      fs.writeFileSync(path.join(root, "README.md"), "base\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "base");
      fs.writeFileSync(path.join(root, "app.txt"), "changed line one\n");
      const harness = makeProvider({ blockVerification: true, candidatesPerCall: 1 });
      const completion = await runQualityCompletion({ cwd: root, mode: "full", provider: harness.provider });
      expect(completion.review?.status).toBe("partial");
      expect(completion.completionAllowed).toBe(true);
      expect(completion.passed).toBe(true);
      expect(completion.advisoryReview.status).toBe("timeout");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
