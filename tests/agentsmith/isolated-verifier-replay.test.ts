import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import { sha256 } from "../../src/core/hash.js";
import { readEvalCase, readStageReplay } from "../../tools/agentsmith-evals/src/case.js";
import { runEvalCases } from "../../tools/agentsmith-evals/src/eval.js";

const root = path.resolve(import.meta.dirname, "../..");
const slug = "auth-guard-bypass";

function evidenceIds(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\[([0-9a-f]{16})\]/g)].map((match) => match[1]))];
}

describe("isolated verifier replay", () => {
  it("loads a reviewed digest-bound replay without changing the strict candidate oracle", () => {
    const { definition } = readEvalCase(root, slug);
    const replay = readStageReplay(root, slug, definition);
    const replayPath = path.join(root, "evals", "agentsmith", slug, definition.stageReplay!.path);

    expect(definition.expectations.candidates?.items.map((candidate) => candidate.id)).toEqual([
      "member-session-bypasses-admin-guard",
    ]);
    expect(sha256(fs.readFileSync(replayPath))).toBe(definition.stageReplay?.sha256);
    expect(replay).toMatchObject({ reviewed: true, fixtureDigest: definition.source.fixture?.digest });
    expect(replay.goldenCandidates.map((candidate) => candidate.id)).toEqual([
      "replay-supported-member-bypass",
      "replay-contradicted-member-blocked",
      "replay-unsupported-retention-policy",
    ]);
    expect(replay.verificationExpectations.map((expectation) => expectation.expectedVerdict)).toEqual([
      "verified",
      "rejected",
      "insufficient_evidence",
    ]);
  });

  it("runs only seeded downstream verification for the isolated verification stage", async () => {
    const outputKinds: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M", "qwen3.5:122b-a10b"] }),
      invoke: async (input) => {
        outputKinds.push(input.outputKind);
        if (input.outputKind !== "verification")
          throw new Error(`Unexpected provider call during isolated verification: ${input.outputKind}`);
        const ids = evidenceIds(input.prompt);
        if (input.prompt.includes("Member session bypasses the admin guard"))
          return {
            raw: JSON.stringify({
              verdict: "verified",
              confidence: 1,
              reasoningSummary: "The member role reaches deletion because the conjunction short-circuits.",
              supportingEvidenceIds: ids,
            }),
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        if (input.prompt.includes("Member sessions are blocked by the admin guard"))
          return {
            raw: JSON.stringify({
              verdict: "rejected",
              confidence: 1,
              reasoningSummary: "The changed guard directly contradicts the claim that a present member is blocked.",
              supportingEvidenceIds: ids,
            }),
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        if (input.prompt.includes("External retention policy may be violated"))
          return {
            raw: JSON.stringify({
              verdict: "insufficient_evidence",
              confidence: 1,
              reasoningSummary: "No retention contract is present in the supplied evidence.",
              supportingEvidenceIds: [],
            }),
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        throw new Error("Unexpected seeded verifier candidate");
      },
    };

    const report = await runEvalCases({
      root,
      slugs: [slug],
      modes: ["partitioned-interactions"],
      replay: "isolated",
      stages: ["verification"],
      provider,
    });
    const result = report.cases[0].results[0];
    const verification = result.stages.find((stage) => stage.stage === "verification");

    expect(
      outputKinds,
      JSON.stringify(
        {
          candidates: result.diagnostics.candidates,
          evidenceOutcomes: result.diagnostics.evidenceOutcomes,
          verification: result.diagnostics.verification,
          coverage: result.coverage,
        },
        null,
        2,
      ),
    ).toEqual(["verification", "verification", "verification"]);
    expect(result.diagnostics.candidateCalls.every((call: { inputTokens: number; outputTokens: number }) =>
      call.inputTokens === 0 && call.outputTokens === 0,
    )).toBe(true);
    expect(result.diagnostics.candidates.map((candidate: { id: string }) => candidate.id)).toEqual(
      expect.arrayContaining([
        "replay-supported-member-bypass",
        "replay-contradicted-member-blocked",
        "replay-unsupported-retention-policy",
      ]),
    );
    expect(result.diagnostics.candidates).toHaveLength(3);
    expect(verification?.metrics.find((metric) => metric.name === "verification_accuracy")).toMatchObject({
      value: 1,
      numerator: 3,
      denominator: 3,
    });
    expect(verification?.metrics.find((metric) => metric.name === "falseVerifications")).toMatchObject({ value: 0 });
  });

});
