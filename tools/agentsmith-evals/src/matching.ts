import type { ReviewFinding } from "../../../src/core/types.js";
import type { EvalCase } from "./case.js";

export type ExpectedFinding = NonNullable<EvalCase["expectations"]["aggregation"]>["findings"][number];

export function findingMatches(actual: ReviewFinding, expected: ExpectedFinding): boolean {
  if (actual.file !== expected.file || actual.line < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  if (expected.severity && actual.severity !== expected.severity) return false;
  if (expected.titleContains && !actual.title.toLowerCase().includes(expected.titleContains.toLowerCase()))
    return false;
  return expected.requiredEvidence.every((anchor) =>
    actual.evidence.some(
      (record) => record.id === anchor || record.snippet.toLowerCase().includes(anchor.toLowerCase()),
    ),
  );
}
