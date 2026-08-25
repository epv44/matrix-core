import { listEvalCases, readEvalCase } from "./case.js";
import type { EvalStage } from "./stage-score.js";

const stages: EvalStage[] = [
  "snapshot",
  "graph",
  "planning",
  "candidates",
  "evidence",
  "verification",
  "aggregation",
  "reporting",
];

export function corpusCoverage(root: string) {
  const cases = listEvalCases(root, true).map((slug) => readEvalCase(root, slug).definition);
  const activeBenchmarks = cases.filter((item) => item.status === "active" && item.kind === "benchmark");
  const discoveryClasses = Object.fromEntries(
    ["L0", "L1", "L2", "L3"].map((level) => [
      level,
      activeBenchmarks.reduce(
        (sum, item) =>
          sum +
          (item.expectations.aggregation?.findings.filter((finding) => finding.discoveryClass === level).length ?? 0),
        0,
      ),
    ]),
  );
  const outcomes = Object.fromEntries(
    ["clear", "findings", "incomplete"].map((outcome) => [
      outcome,
      activeBenchmarks.filter((item) => item.expectations.aggregation?.outcome === outcome).length,
    ]),
  );
  const stageCoverage = Object.fromEntries(
    stages.map((stage) => [stage, activeBenchmarks.filter((item) => Boolean(item.expectations[stage])).length]),
  );
  return {
    totalCases: cases.length,
    activeBenchmarks: activeBenchmarks.length,
    drafts: cases.filter((item) => item.status === "draft").length,
    conformance: cases.filter((item) => item.kind === "conformance").length,
    withFrozenRepository: cases.filter((item) => Boolean(item.source.fixture)).length,
    discoveryClasses,
    outcomes,
    stageCoverage,
  };
}
