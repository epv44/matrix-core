import type { CandidateFinding } from "../../../src/core/types.js";
import { candidateAnchorIssue, evidenceLocatorParts } from "../../../src/agentsmith/evidence.js";
import type { ReviewScope } from "../../../src/agentsmith/scope.js";
import type { EvalCase } from "./case.js";
import type { StageMetric } from "./stage-score.js";

/**
 * Candidate diagnostics are deliberately separate from the strict candidate
 * oracle. They explain near misses; they never participate in pass/fail or
 * candidate matching.
 */
export type CandidateDiagnosticMetric = StageMetric;

type CandidateExpectation = NonNullable<EvalCase["expectations"]["candidates"]>["items"][number];
type ExpectedFinding = NonNullable<EvalCase["expectations"]["aggregation"]>["findings"][number];

const STOP_WORDS = new Set(
  [
    "a", "an", "and", "are", "as", "at", "be", "by", "can", " for", "from", "has", "in", "is", "it",
    "its", "now", "of", "on", "or", "that", "the", "to", "was", "while", "with",
  ].map((word) => word.trim()),
);

function ratio(numerator: number, denominator: number): CandidateDiagnosticMetric {
  return {
    name: "",
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    direction: "higher",
  };
}

function terms(value: string): string[] {
  return [...new Set(
    (value.toLowerCase().match(/[a-z_$][a-z0-9_$]*(?:\.[a-z_$][a-z0-9_$]*)*|\d+(?:\.\d+)?|&&|\|\|/g) ?? [])
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  )];
}

function termRecall(expected: string[], actual: string): CandidateDiagnosticMetric {
  const expectedTerms = [...new Set(expected.flatMap((value) => terms(value)))];
  if (!expectedTerms.length) return ratio(0, 0);
  const actualTerms = terms(actual);
  return ratio(expectedTerms.filter((term) => actualTerms.includes(term)).length, expectedTerms.length);
}

function textSimilarity(left: string, right: string): number | null {
  const leftTerms = new Set(terms(left));
  const rightTerms = new Set(terms(right));
  if (!leftTerms.size || !rightTerms.size) return null;
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const union = new Set([...leftTerms, ...rightTerms]).size;
  return union ? intersection / union : null;
}

function claimCompleteness(value: string | undefined): boolean {
  if (!value) return false;
  return /^\s*Trigger\s*:\s*\S[\s\S]*?\bInvariant\s*:\s*\S[\s\S]*?\bImpact\s*:\s*\S[\s\S]*$/i.test(value);
}

function overlaps(actual: CandidateFinding, expected: CandidateExpectation): boolean {
  return (
    actual.file === expected.file &&
    (actual.endLine ?? actual.line) >= expected.lineStart &&
    actual.line <= expected.lineEnd
  );
}

function categoryCompatible(candidate: CandidateFinding | undefined, expected: CandidateExpectation): boolean {
  return Boolean(candidate && (!expected.category || candidate.category === expected.category));
}

function severityCompatible(candidate: CandidateFinding | undefined, expected: CandidateExpectation): boolean {
  return Boolean(candidate && (!expected.severity || candidate.severity === expected.severity));
}

function compatible(candidate: CandidateFinding | undefined, expected: CandidateExpectation): boolean {
  return categoryCompatible(candidate, expected) && severityCompatible(candidate, expected);
}

function strictMatch(candidate: CandidateFinding | undefined, expected: CandidateExpectation): boolean {
  if (!candidate || !overlaps(candidate, expected) || !compatible(candidate, expected)) return false;
  return !expected.titleContains || candidate.title.toLowerCase().includes(expected.titleContains.toLowerCase());
}

function expectedFindingFor(
  definition: EvalCase,
  expected: CandidateExpectation,
): ExpectedFinding | undefined {
  return definition.expectations.aggregation?.findings.find((finding) => finding.id === expected.id);
}

function locatorShapeIsValid(request: CandidateFinding["evidenceRequests"][number]): boolean {
  const locator = evidenceLocatorParts(request);
  if (request.locatorMode === "symbol") return Boolean(request.symbol && locator.symbolLocatorValid);
  if (request.locatorMode === "literal") return Boolean(request.query?.trim());
  return Boolean((request.symbol && locator.symbolLocatorValid) || request.query?.trim());
}

function scopePathMatches(scope: ReviewScope, pathHint: string): boolean {
  const files = [...Object.keys(scope.fileContents), ...Object.keys(scope.suppliedContext)];
  return files.some((file) => file === pathHint || file.endsWith(`/${pathHint}`));
}

function scopeContentMatches(scope: ReviewScope, request: CandidateFinding["evidenceRequests"][number]): boolean {
  const locator = evidenceLocatorParts(request);
  if (locator.pathHint && !scopePathMatches(scope, locator.pathHint)) return false;
  const files = [...new Set([...Object.keys(scope.fileContents), ...Object.keys(scope.suppliedContext)])]
    .filter((file) => !locator.pathHint || file === locator.pathHint || file.endsWith(`/${locator.pathHint}`));
  const contents = files.map((file) => scope.fileContents[file] ?? scope.suppliedContext[file] ?? "");
  if (request.locatorMode === "literal" || request.query) {
    const query = request.query?.trim();
    return Boolean(query && contents.some((content) => content.includes(query)));
  }
  const symbols = locator.symbolCandidates;
  return Boolean(symbols.length && contents.some((content) => symbols.some((symbol) => content.includes(symbol))));
}

function pairCandidates(
  candidates: CandidateFinding[],
  expected: CandidateExpectation[],
): Map<string, CandidateFinding> {
  const pairs = expected.flatMap((item) =>
    candidates
      .filter((candidate) => candidate.file === item.file)
      .map((candidate) => ({
        expected: item,
        candidate,
        score:
          (overlaps(candidate, item) ? 1_000_000 : 0) +
          (categoryCompatible(candidate, item) ? 10_000 : 0) +
          (severityCompatible(candidate, item) ? 1_000 : 0) -
          Math.abs(candidate.line - item.lineStart),
      })),
  );
  pairs.sort(
    (left, right) =>
      right.score - left.score ||
      left.expected.id.localeCompare(right.expected.id) ||
      left.candidate.id.localeCompare(right.candidate.id),
  );
  const assignedExpected = new Set<string>();
  const assignedCandidates = new Set<string>();
  const result = new Map<string, CandidateFinding>();
  for (const pair of pairs) {
    if (assignedExpected.has(pair.expected.id) || assignedCandidates.has(pair.candidate.id)) continue;
    assignedExpected.add(pair.expected.id);
    assignedCandidates.add(pair.candidate.id);
    result.set(pair.expected.id, pair.candidate);
  }
  return result;
}

function metric(name: string, value: Omit<CandidateDiagnosticMetric, "name"> | CandidateDiagnosticMetric): CandidateDiagnosticMetric {
  return { ...value, name };
}

export function collectCandidateNearMissDiagnostics(opts: {
  definition: EvalCase;
  scope: ReviewScope;
  candidates: CandidateFinding[];
}): { metrics: CandidateDiagnosticMetric[]; diagnosticOnly: string[] } {
  const desired = (opts.definition.expectations.candidates?.items ?? []).filter((item) => item.expectedPresence);
  if (!desired.length) return { metrics: [], diagnosticOnly: [] };

  const pairings = pairCandidates(opts.candidates, desired);
  const pairs = desired.map((expected) => ({
    expected,
    actual: pairings.get(expected.id),
    finding: expectedFindingFor(opts.definition, expected),
  }));
  const actualText = (candidate: CandidateFinding | undefined) =>
    candidate ? `${candidate.title} ${candidate.description}` : "";

  const fileOverlap = pairs.filter(({ actual, expected }) => actual?.file === expected.file).length;
  const regionOverlap = pairs.filter(({ actual, expected }) => Boolean(actual && overlaps(actual, expected))).length;
  const categoryCompatibleCount = pairs.filter(({ actual, expected }) => categoryCompatible(actual, expected)).length;
  const severityCompatibleCount = pairs.filter(({ actual, expected }) => severityCompatible(actual, expected)).length;
  const anchorValid = opts.candidates.filter((candidate) => !candidateAnchorIssue(candidate, opts.scope)).length;
  const anchorDistances = pairs
    .filter(({ actual }) => actual)
    .map(({ actual, expected }) => Math.abs(actual!.line - expected.lineStart));
  const titleSimilarities = pairs
    .map(({ actual, expected }) => textSimilarity(expected.titleContains ?? "", actual?.title ?? ""))
    .filter((value): value is number => value !== null);
  const completeClaims = pairs.filter(({ actual }) => claimCompleteness(actual?.description)).length;

  let requiredEvidenceKinds = 0;
  let requestedEvidenceKinds = 0;
  let validLocatorShapes = 0;
  let validLocatorScopes = 0;
  let locators = 0;
  let strictOracleOnlyRejected = 0;
  for (const { expected, actual } of pairs) {
    requiredEvidenceKinds += expected.requiredEvidenceKinds.length;
    requestedEvidenceKinds += expected.requiredEvidenceKinds.filter((kind) =>
      actual?.evidenceRequests.some((request) => request.kind === kind),
    ).length;
    for (const request of actual?.evidenceRequests ?? []) {
      locators += 1;
      if (locatorShapeIsValid(request)) validLocatorShapes += 1;
      if (locatorShapeIsValid(request) && scopeContentMatches(opts.scope, request)) validLocatorScopes += 1;
    }
    if (actual && overlaps(actual, expected) && compatible(actual, expected) && !strictMatch(actual, expected))
      strictOracleOnlyRejected += 1;
  }

  const triggeringValueRecall = pairs.map(({ expected, actual }) =>
    termRecall(expected.requiredReasoningTerms, actualText(actual)),
  );
  const invariantTermRecall = pairs.map(({ finding, actual }) =>
    termRecall(terms(finding?.rationale ?? ""), actualText(actual)),
  );
  const observableImpactTermRecall = pairs.map(({ finding, actual }) =>
    termRecall(terms(finding?.description ?? ""), actualText(actual)),
  );
  const mean = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const diagnosticOnly = pairs
    .filter(({ actual, expected }) => actual && !strictMatch(actual, expected))
    .map(({ actual, expected }) => `${expected.id}: semantic candidate rejected by strict oracle at ${actual!.file}:${actual!.line}`);
  return {
    metrics: [
      metric("changedFileOverlap", ratio(fileOverlap, desired.length)),
      metric("changedRegionOverlap", ratio(regionOverlap, desired.length)),
      metric("categoryCompatibility", ratio(categoryCompatibleCount, desired.length)),
      metric("severityCompatibility", ratio(severityCompatibleCount, desired.length)),
      metric("triggeringValueRecall", {
        ...ratio(0, 0),
        value: mean(triggeringValueRecall.map((item) => item.value).filter((value): value is number => value !== null)),
        direction: "higher",
      }),
      metric("violatedInvariantTermRecall", {
        ...ratio(0, 0),
        value: mean(invariantTermRecall.map((item) => item.value).filter((value): value is number => value !== null)),
        direction: "higher",
      }),
      metric("observableImpactTermRecall", {
        ...ratio(0, 0),
        value: mean(observableImpactTermRecall.map((item) => item.value).filter((value): value is number => value !== null)),
        direction: "higher",
      }),
      metric("titleSimilarity", { value: mean(titleSimilarities), direction: "higher" }),
      metric("claimCompleteness", ratio(completeClaims, desired.length)),
      metric("anchorValidityDiagnostic", ratio(anchorValid, opts.candidates.length)),
      metric("anchorDistance", { value: mean(anchorDistances), direction: "lower" }),
      metric("evidenceRequestCompletenessDiagnostic", ratio(requestedEvidenceKinds, requiredEvidenceKinds)),
      metric("evidenceRequestLocatorValidity", ratio(validLocatorShapes, locators)),
      metric("evidenceRequestLocatorScopeValidity", ratio(validLocatorScopes, locators)),
      metric("strictOracleOnlyRejection", ratio(strictOracleOnlyRejected, desired.length)),
    ],
    diagnosticOnly,
  };
}
