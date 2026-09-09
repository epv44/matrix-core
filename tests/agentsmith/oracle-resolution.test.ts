import { describe, expect, it } from "vitest";
import {
  deriveEvalStatus,
  evaluateOracleResolutions,
} from "../../tools/agentsmith-evals/src/oracle-resolution.js";

function definition(labels: Array<Record<string, unknown>>, outcome: "clear" | "findings" = "findings") {
  return {
    expectations: {
      candidates: { items: labels },
      verification: { candidates: labels },
      aggregation: { outcome, findings: [] },
    },
  } as any;
}

const positive = {
  id: "expected",
  file: "src/a.ts",
  lineStart: 3,
  lineEnd: 3,
  category: "contract",
  expectedPresence: true,
  expectedVerdict: "verified",
  requiredEvidenceKinds: [],
  requiredReasoningTerms: [],
  forbiddenReasoningTerms: [],
  rationale: "oracle",
};

function execution(candidates: any[] = [], verification: any[] = []) {
  return { candidates, verification, evidence: {}, evidenceOutcomes: {} } as any;
}

const result = { status: "completed", findings: [], incompleteReasons: [] } as any;

describe("eval oracle resolution", () => {
  it("records a missing expected candidate as a definitive miss", () => {
    const audits = evaluateOracleResolutions({ definition: definition([positive]), execution: execution(), result });
    expect(audits).toEqual([
      expect.objectContaining({
        oracleId: "expected",
        expectedDisposition: "proven",
        resolution: "missed",
        oracleSatisfied: false,
        reasonCode: "candidate-miss",
      }),
    ]);
    expect(deriveEvalStatus({ executionStatus: "completed", oracleResolutions: audits, stages: [] })).toBe("fail");
  });

  it("records completed verifier abstention as eval partial, not execution partial", () => {
    const candidate = { id: "candidate", file: "src/a.ts", line: 3, category: "contract", title: "expected", evidenceRequests: [] };
    const audits = evaluateOracleResolutions({
      definition: definition([positive]),
      execution: execution([candidate], [{ candidateId: "candidate", verdict: "insufficient_evidence", diagnostics: {} }]),
      result,
    });
    expect(audits[0]).toMatchObject({
      resolution: "unproven",
      oracleSatisfied: false,
      reasonCode: "verifier-insufficient-evidence",
    });
    expect(deriveEvalStatus({ executionStatus: "completed", oracleResolutions: audits, stages: [] })).toBe("partial");
  });

  it("fails when verification succeeds but the required final finding is not published", () => {
    const candidate = { id: "candidate", file: "src/a.ts", line: 3, category: "contract", title: "expected", evidenceRequests: [] };
    const audits = evaluateOracleResolutions({
      definition: definition([positive]),
      execution: execution([candidate], [{ candidateId: "candidate", verdict: "verified", diagnostics: {} }]),
      result,
    });
    expect(audits[0]).toMatchObject({
      resolution: "proven",
      oracleSatisfied: false,
      reasonCode: "aggregation-miss",
    });
    expect(deriveEvalStatus({ executionStatus: "completed", oracleResolutions: audits, stages: [] })).toBe("fail");
  });

  it("passes a negative oracle when the forbidden candidate is absent", () => {
    const negative = { ...positive, expectedPresence: false, expectedVerdict: "rejected" };
    const audits = evaluateOracleResolutions({
      definition: definition([negative], "clear"),
      execution: execution(),
      result,
    });
    expect(audits[0]).toMatchObject({ resolution: "disproven", oracleSatisfied: true, reasonCode: null });
    expect(deriveEvalStatus({ executionStatus: "completed", oracleResolutions: audits, stages: [] })).toBe("pass");
  });

  it("gives a definitive miss precedence over a different unproven candidate", () => {
    const second = { ...positive, id: "second", lineStart: 8, lineEnd: 8 };
    const candidate = { id: "candidate", file: "src/a.ts", line: 8, category: "contract", title: "second", evidenceRequests: [] };
    const audits = evaluateOracleResolutions({
      definition: definition([positive, second]),
      execution: execution([candidate], [{ candidateId: "candidate", verdict: "likely", diagnostics: {} }]),
      result,
    });
    expect(audits.map((item) => item.resolution)).toEqual(["missed", "unproven"]);
    expect(deriveEvalStatus({ executionStatus: "completed", oracleResolutions: audits, stages: [] })).toBe("fail");
  });

  it("does not count an intentionally unscoped stage as partial", () => {
    expect(
      deriveEvalStatus({
        executionStatus: "completed",
        oracleResolutions: [],
        stages: [
          { stage: "planning", evaluation: "executed", causalStatus: "healthy", metrics: [], diagnostics: [] },
          { stage: "ranking", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] },
        ],
      }),
    ).toBe("pass");
  });

  it("records an applicable stage that could not be evaluated as partial", () => {
    expect(
      deriveEvalStatus({
        executionStatus: "completed",
        oracleResolutions: [],
        stages: [
          { stage: "planning", evaluation: "observed", causalStatus: "healthy", metrics: [], diagnostics: [] },
          { stage: "ranking", evaluation: "not-evaluable", metrics: [], diagnostics: ["manifest unavailable"] },
          { stage: "selection", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] },
        ],
      }),
    ).toBe("partial");
  });

  it("records an unexpected unresolved candidate in an exhaustive negative case", () => {
    const negative = { ...positive, expectedPresence: false, expectedVerdict: "rejected" };
    const candidate = { id: "other", file: "src/a.ts", line: 9, category: "contract", title: "other", evidenceRequests: [] };
    const exhaustive = {
      ...definition([negative], "clear"),
      groundTruth: { exhaustiveCandidates: true },
    } as any;
    const audits = evaluateOracleResolutions({
      definition: exhaustive,
      execution: execution([candidate], [{ candidateId: "other", verdict: "insufficient_evidence", diagnostics: {} }]),
      result,
    });
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ oracleId: "unexpected:other", resolution: "unproven", oracleSatisfied: false }),
    ]));
    expect(
      deriveEvalStatus({
        executionStatus: "completed",
        oracleResolutions: audits,
        stages: [{ stage: "aggregation", evaluation: "executed", causalStatus: "root-failure", metrics: [], diagnostics: [] }],
      }),
    ).toBe("partial");
  });
});
