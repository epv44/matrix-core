import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  adaptLegacyReviewResultV3,
  isCurrentReviewResult,
  readReviewResult,
} from "../../src/agentsmith/review-store.js";

const coverage = {
  changedFiles: 1,
  changedFilesReviewed: 1,
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
} as const;

function writeArtifact(root: string, value: unknown) {
  fs.mkdirSync(path.join(root, ".quality"), { recursive: true });
  fs.writeFileSync(path.join(root, ".quality", "review-result.yaml"), yaml.dump(value));
}

describe("review result persistence", () => {
  it("reads native v4 results only when candidate resolution audits are present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-review-store-"));
    try {
      writeArtifact(root, {
        schemaVersion: 4,
        version: "v4",
        status: "completed",
        outcome: "clear",
        mode: "partitioned",
        reviewPath: "generic",
        findings: [],
        coverage,
        summary: "clear",
        timestamp: "now",
        reviewer: "AgentSmith",
        candidateResolutions: [],
      });
      const current = readReviewResult(root);
      expect(current).toMatchObject({ schemaVersion: 4 });
      expect(current).not.toHaveProperty("migratedFromSchemaVersion");

      writeArtifact(root, {
        schemaVersion: 4,
        version: "invalid-v4",
        findings: [],
        coverage,
      });
      expect(readReviewResult(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adapts v3 abstention conservatively without calling it current cache evidence", () => {
    const legacy = {
      schemaVersion: 3,
      version: "v3",
      status: "partial",
      outcome: "incomplete",
      mode: "partitioned",
      reviewPath: "generic",
      findings: [],
      coverage,
      summary: "insufficient",
      timestamp: "now",
      reviewer: "AgentSmith",
      candidates: { generated: 1, verified: 0, likely: 0, rejected: 0, insufficientEvidence: 1 },
      incompleteReasons: [{ kind: "insufficient-evidence", id: "candidate-1", detail: "caller missing" }],
      cacheHit: true,
    };
    const adapted = adaptLegacyReviewResultV3(legacy);

    expect(isCurrentReviewResult(legacy)).toBe(false);
    expect(isCurrentReviewResult(adapted)).toBe(false);
    expect(adapted).toMatchObject({
      schemaVersion: 4,
      migratedFromSchemaVersion: 3,
      status: "partial",
      outcome: "incomplete",
      cacheHit: false,
      candidateResolutions: [
        {
          candidateId: "candidate-1",
          resolution: "unproven",
          reasonCode: "verifier-insufficient-evidence",
          verifier: { verdict: "insufficient_evidence" },
        },
      ],
    });
  });
});
