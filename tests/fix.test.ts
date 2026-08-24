import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { prepareFix } from "../src/core/fix.js";
import { computeWorkspaceVersion } from "../src/core/version.js";

describe("prepareFix", () => {
  it("returns a host repair task for explicit current finding IDs and becomes stale after edits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-fix-"));
    try {
      fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: fix-test\n");
      fs.writeFileSync(path.join(root, "bug.ts"), "throw new Error('bug')\n");
      const version = computeWorkspaceVersion(root);
      fs.mkdirSync(path.join(root, ".quality"));
      fs.writeFileSync(
        path.join(root, ".quality", "review-result.yaml"),
        yaml.dump({
          schemaVersion: 3,
          version,
          status: "completed",
          outcome: "findings",
          mode: "partitioned",
          reviewPath: "generic",
          findings: [
            {
              id: "bug-1",
              severity: "high",
              category: "correctness",
              title: "bug",
              description: "bug",
              file: "bug.ts",
              line: 1,
              confidence: "verified",
              evidence: [],
              sourceWorkItemIds: ["local"],
              sourceReviewers: [],
            },
          ],
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
          timestamp: new Date().toISOString(),
          reviewer: "AgentSmith",
        }),
      );
      const ready = prepareFix({ cwd: root, reviewVersion: version, findingIds: ["bug-1"] });
      expect(ready.status).toBe("READY");
      expect(ready.context["bug.ts"]).toContain("bug");
      expect(ready.instructions.join(" ")).toContain("active host model");
      fs.writeFileSync(path.join(root, "bug.ts"), "fixed\n");
      expect(prepareFix({ cwd: root, reviewVersion: version, findingIds: ["bug-1"] }).status).toBe("STALE");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects implicit or unknown findings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-fix-"));
    try {
      fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: fix-test\n");
      const version = computeWorkspaceVersion(root);
      fs.mkdirSync(path.join(root, ".quality"));
      fs.writeFileSync(
        path.join(root, ".quality", "review-result.yaml"),
        yaml.dump({
          schemaVersion: 3,
          version,
          status: "completed",
          outcome: "clear",
          mode: "partitioned",
          reviewPath: "generic",
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
          summary: "No verified findings.",
          timestamp: "now",
          reviewer: "AgentSmith",
        }),
      );
      expect(prepareFix({ cwd: root, reviewVersion: version, findingIds: [] }).status).toBe("INVALID");
      expect(prepareFix({ cwd: root, reviewVersion: version, findingIds: ["missing"] }).errors[0]).toContain("Unknown");
      expect(prepareFix({ cwd: root, reviewVersion: version, findingIds: ["claim-1"] }).errors[0]).toContain(
        "unpublished",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
