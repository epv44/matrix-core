import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compactEvidenceRecord, executeReviewEngine } from "../../src/agentsmith/engine.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import { captureReviewScope } from "../../src/agentsmith/scope.js";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";
import type { CandidateFinding } from "../../src/core/types.js";

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function executeWithVerifier(
  verifier: (prompt: string) => {
    verdict: string;
    confidence: number;
    reasoningSummary?: string;
    supportingEvidenceIds: string[];
  },
  configure?: (config: ReturnType<typeof agentSmithConfigFromPolicy>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-result-v4-engine-"));
  try {
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: result-v4\nreview:\n  agentsmith: true\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "result-v4", private: true }));
    fs.writeFileSync(path.join(root, "subject.ts"), "export const value = 1;\n");
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    fs.writeFileSync(path.join(root, "subject.ts"), "export const value = 2;\n");
    const scope = captureReviewScope({ root, base: "HEAD" });
    const config = agentSmithConfigFromPolicy(true);
    config.mode = "partitioned";
    config.cache = false;
    configure?.(config);
    const candidate: CandidateFinding = {
      id: "candidate-1",
      sourceWorkItemIds: [],
      sourceReviewers: [],
      file: "subject.ts",
      line: 1,
      severity: "high",
      category: "correctness",
      title: "Candidate",
      description: "The changed value may violate a caller contract.",
      evidenceRequests: [],
      candidateConfidence: 0.8,
    };
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M", "qwen3.5:122b-a10b"] }),
      invoke: async (input) => {
        if (input.outputKind === "citation-selection")
          return { raw: JSON.stringify({ citations: [] }), usage: { inputTokens: 10, outputTokens: 5 } };
        if (input.outputKind !== "verification") throw new Error(`Unexpected provider call: ${input.outputKind}`);
        return { raw: JSON.stringify(verifier(input.prompt)), usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    return await executeReviewEngine({
      root,
      version: scope.version,
      scope,
      config,
      provider,
      variant: { seedCandidates: [candidate] },
      enforceWorkspaceVersion: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function anchorId(prompt: string) {
  return /\[([0-9a-f]{16})\]/.exec(prompt)?.[1] ?? "missing-anchor";
}

describe("ReviewResult v4 engine semantics", () => {
  it("compacts evidence around the matched locator instead of truncating its prefix", () => {
    const record = {
      id: "evidence-1",
      requestKind: "implementation" as const,
      file: "service.py",
      startLine: 10,
      endLine: 30,
      matchedLocator: "cash_snapshot",
      snippet: Array.from({ length: 21 }, (_, index) =>
        index === 15 ? `line ${index} cash_snapshot` : `line ${index} supporting context`,
      ).join("\n"),
    };
    const compacted = compactEvidenceRecord(record, 100);
    expect(compacted.snippet).toContain("cash_snapshot");
    expect(compacted.snippet.length).toBeLessThanOrEqual(100);
    expect(compacted.startLine).toBeGreaterThan(record.startLine);
    expect(compacted.endLine).toBeLessThanOrEqual(record.endLine);
  });

  it.each(["likely", "insufficient_evidence"] as const)(
    "records a valid %s abstention without marking execution partial",
    async (verdict) => {
      const { result, execution } = await executeWithVerifier((prompt) => ({
        verdict,
        confidence: 0.5,
        reasoningSummary: "The available evidence does not establish the claim.",
        supportingEvidenceIds: verdict === "likely" ? [anchorId(prompt)] : [],
      }));

      expect(result).toMatchObject({ schemaVersion: 4, status: "completed", outcome: "incomplete" });
      expect(result.incompleteReasons).toEqual([]);
      expect(result.candidateResolutions).toEqual([
        expect.objectContaining({
          candidateId: "candidate-1",
          resolution: "unproven",
          reasonCode: verdict === "likely" ? "verifier-likely-unpublished" : "verifier-insufficient-evidence",
          verifier: expect.objectContaining({ verdict }),
        }),
      ]);
      expect(execution.candidateResolutions).toEqual(result.candidateResolutions);
      expect(execution.contractShadow).toMatchObject({ schemaVersion: 1, lens: "correctness" });
      expect(execution.contractShadow?.entries.every((entry) => entry.validation.valid)).toBe(true);
    },
  );

  it("keeps citation failure after repair as partial execution", async () => {
    const { result } = await executeWithVerifier(() => ({
      verdict: "verified",
      confidence: 1,
      supportingEvidenceIds: ["invented-evidence-id"],
    }));

    expect(result).toMatchObject({ status: "partial", outcome: "incomplete" });
    expect(result.candidateResolutions[0]).toMatchObject({
      resolution: "unproven",
      reasonCode: "citation-validation-failure",
      verifier: { verdict: "insufficient_evidence", citationRepairAttempted: true },
    });
    expect(result.incompleteReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "citation-validation-failure" })]),
    );
  });

  it("keeps aggregate verification budget omission as partial execution", async () => {
    const { result } = await executeWithVerifier(
      () => ({ verdict: "insufficient_evidence", confidence: 0, supportingEvidenceIds: [] }),
      (config) => {
        config.partitioned.maxVerificationInputTokens = 1;
      },
    );

    expect(result).toMatchObject({ status: "partial", outcome: "incomplete" });
    expect(result.candidateResolutions[0]).toMatchObject({
      resolution: "unproven",
      reasonCode: "evidence-packing-budget",
      verifier: { verdict: "not_run" },
    });
  });
});
