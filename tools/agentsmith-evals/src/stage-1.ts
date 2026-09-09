import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReviewWorkItem } from "../../../src/agentsmith/engine-types.js";
import type { ReviewFinding } from "../../../src/core/types.js";
import type { EvalCase } from "./case.js";
import { findingMatches } from "./matching.js";

export type Stage1Attribution =
  | "coverage-budget-failure"
  | "selection-miss"
  | "model-miss"
  | "verification-rejection"
  | "found";

export type Stage1GoldFinding = NonNullable<EvalCase["expectations"]["aggregation"]>["findings"][number];

export interface Stage1SelectionScore {
  selected: boolean;
  selectedWorkItemId: string | null;
  changedLocationCovered: boolean;
  minimumEvidenceCovered: boolean;
  missingEvidence: number[];
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftEnd >= rightStart && leftStart <= rightEnd;
}

function symbolNames(item: ReviewWorkItem): Set<string> {
  return new Set(
    [...item.primarySymbols, ...item.relatedSymbols].flatMap((symbol) => [
      symbol.name,
      symbol.qualifiedName,
      `${symbol.file}#${symbol.qualifiedName}`,
    ]),
  );
}

function workItemCoversEvidence(
  item: ReviewWorkItem,
  evidence: NonNullable<Stage1GoldFinding["minimumEvidence"]>[number],
): boolean {
  const names = symbolNames(item);
  return item.code.some((snippet) => {
    if (snippet.file !== evidence.file) return false;
    if (evidence.lineStart !== undefined && snippet.endLine < evidence.lineStart) return false;
    if (evidence.lineEnd !== undefined && snippet.startLine > evidence.lineEnd) return false;
    if (evidence.symbol && snippet.symbol !== evidence.symbol && !names.has(evidence.symbol)) return false;
    const content = snippet.content.toLowerCase();
    return evidence.contains.every((anchor) => content.includes(anchor.toLowerCase()));
  });
}

/** A gold is selected only when one work item contains both its changed location and all required evidence. */
export function scoreStage1Selection(
  gold: Stage1GoldFinding,
  workItems: ReviewWorkItem[],
): Stage1SelectionScore {
  const evidence = gold.minimumEvidence ?? [];
  let changedLocationCovered = false;
  let bestMissing = evidence.map((_, index) => index);
  for (const item of workItems) {
    const changedCovered = item.code.some(
      (snippet) =>
        snippet.file === gold.file && overlaps(snippet.startLine, snippet.endLine, gold.lineStart, gold.lineEnd),
    );
    if (!changedCovered) continue;
    changedLocationCovered = true;
    const missing = evidence.flatMap((descriptor, index) =>
      workItemCoversEvidence(item, descriptor) ? [] : [index],
    );
    if (missing.length < bestMissing.length) bestMissing = missing;
    if (!missing.length)
      return {
        selected: true,
        selectedWorkItemId: item.id,
        changedLocationCovered: true,
        minimumEvidenceCovered: true,
        missingEvidence: [],
      };
  }
  return {
    selected: false,
    selectedWorkItemId: null,
    changedLocationCovered,
    minimumEvidenceCovered: evidence.length === 0 || bestMissing.length === 0,
    missingEvidence: bestMissing,
  };
}

export interface Stage1FindingClassificationInput {
  coverageBudgetFailure: boolean;
  selected: boolean;
  candidateFound: boolean;
  verifiedFound: boolean;
}

/** Classification precedence is deliberate and mirrors the migration roadmap. */
export function classifyStage1Finding(input: Stage1FindingClassificationInput): Stage1Attribution {
  if (input.coverageBudgetFailure) return "coverage-budget-failure";
  if (!input.selected) return "selection-miss";
  if (!input.candidateFound) return "model-miss";
  if (!input.verifiedFound) return "verification-rejection";
  return "found";
}

interface FindingLocation {
  file: string;
  line: number;
  endLine?: number;
  category?: string;
  severity?: string;
  title: string;
}

function locationMatches(actual: FindingLocation, expected: Stage1GoldFinding): boolean {
  const actualEnd = actual.endLine ?? actual.line;
  if (actual.file !== expected.file || actualEnd < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  if (expected.severity && actual.severity !== expected.severity) return false;
  return !expected.titleContains || actual.title.toLowerCase().includes(expected.titleContains.toLowerCase());
}

function uniqueFindingMatches(
  actual: FindingLocation[],
  expected: Stage1GoldFinding[],
  matches: (actualFinding: FindingLocation, gold: Stage1GoldFinding) => boolean = locationMatches,
) {
  const unmatched = new Set(actual.map((_, index) => index));
  const matched = new Set<string>();
  for (const gold of expected) {
    const index = [...unmatched].find((candidate) => matches(actual[candidate], gold));
    if (index === undefined) continue;
    unmatched.delete(index);
    matched.add(gold.id);
  }
  return { matched, falsePositive: unmatched.size };
}

export interface Stage1RunScore {
  eligibleGold: number;
  selectedGold: number;
  candidateTruePositive: number;
  candidateFalsePositive: number;
  verifiedTruePositive: number;
  verifiedFalsePositive: number;
  attributions: Record<Stage1Attribution, number>;
  gold: Array<{
    id: string;
    selection: Stage1SelectionScore;
    candidateFound: boolean;
    verifiedFound: boolean;
    attribution: Stage1Attribution;
  }>;
}

export function scoreStage1Run(input: {
  goldFindings: Stage1GoldFinding[];
  workItems: ReviewWorkItem[];
  candidates: FindingLocation[];
  verifiedFindings: ReviewFinding[];
  coverageBudgetFailure: boolean;
}): Stage1RunScore {
  const eligible = input.goldFindings.filter((gold) => gold.smallModelExpected !== false);
  const candidateMatches = uniqueFindingMatches(input.candidates, input.goldFindings);
  const verifiedMatches = uniqueFindingMatches(input.verifiedFindings, input.goldFindings, (actual, expected) =>
    findingMatches(actual as ReviewFinding, expected),
  );
  const gold = eligible.map((finding) => {
    const selection = scoreStage1Selection(finding, input.workItems);
    const candidateFound = candidateMatches.matched.has(finding.id);
    const verifiedFound = verifiedMatches.matched.has(finding.id);
    return {
      id: finding.id,
      selection,
      candidateFound,
      verifiedFound,
      attribution: classifyStage1Finding({
        coverageBudgetFailure: input.coverageBudgetFailure,
        selected: selection.selected,
        candidateFound,
        verifiedFound,
      }),
    };
  });
  const attributions: Record<Stage1Attribution, number> = {
    "coverage-budget-failure": 0,
    "selection-miss": 0,
    "model-miss": 0,
    "verification-rejection": 0,
    found: 0,
  };
  for (const item of gold) attributions[item.attribution] += 1;
  return {
    eligibleGold: eligible.length,
    selectedGold: gold.filter((item) => item.selection.selected).length,
    candidateTruePositive: eligible.filter((item) => candidateMatches.matched.has(item.id)).length,
    candidateFalsePositive: candidateMatches.falsePositive,
    verifiedTruePositive: eligible.filter((item) => verifiedMatches.matched.has(item.id)).length,
    verifiedFalsePositive: verifiedMatches.falsePositive,
    attributions,
    gold,
  };
}

export interface Stage1MetricSummary {
  selectionRecall: number | null;
  candidateFindingRecall: number | null;
  candidateFindingPrecision: number | null;
  verifiedFindingRecall: number | null;
  verifiedFindingPrecision: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCallCount: number;
  latencyMeanMs: number | null;
  latencyStdDevMs: number | null;
  partialReviewRate: number | null;
  runs: number;
  attributions: Record<Stage1Attribution, number>;
}

interface Stage1ReportResult {
  mode: string;
  iteration: number;
  status?: string;
  executionStatus?: string;
  outcome: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  errors: string[];
  incompatibilities?: string[];
  stage1?: Stage1RunScore;
  benchmark?: { reliability?: { callsStarted?: number } };
  coverage?: { callsStarted?: number };
  [key: string]: unknown;
}

interface Stage1ReportCase {
  id: string;
  kind?: "benchmark" | "conformance";
  contractFamily?: string;
  results: Stage1ReportResult[];
}

export interface Stage1EvalReport {
  schemaVersion: number;
  corpusHash: string;
  replay: string;
  modes: string[];
  repeat: number;
  cases: Stage1ReportCase[];
  [key: string]: unknown;
}

interface Totals {
  eligibleGold: number;
  selectedGold: number;
  candidateTruePositive: number;
  candidateFalsePositive: number;
  verifiedTruePositive: number;
  verifiedFalsePositive: number;
  inputTokens: number;
  outputTokens: number;
  modelCallCount: number;
  latencies: number[];
  partialRuns: number;
  runs: number;
  attributions: Record<Stage1Attribution, number>;
}

function emptyTotals(): Totals {
  return {
    eligibleGold: 0,
    selectedGold: 0,
    candidateTruePositive: 0,
    candidateFalsePositive: 0,
    verifiedTruePositive: 0,
    verifiedFalsePositive: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelCallCount: 0,
    latencies: [],
    partialRuns: 0,
    runs: 0,
    attributions: {
      "coverage-budget-failure": 0,
      "selection-miss": 0,
      "model-miss": 0,
      "verification-rejection": 0,
      found: 0,
    },
  };
}

function addResult(totals: Totals, result: Stage1ReportResult): void {
  if (!result.stage1) return;
  totals.eligibleGold += result.stage1.eligibleGold;
  totals.selectedGold += result.stage1.selectedGold;
  totals.candidateTruePositive += result.stage1.candidateTruePositive;
  totals.candidateFalsePositive += result.stage1.candidateFalsePositive;
  totals.verifiedTruePositive += result.stage1.verifiedTruePositive;
  totals.verifiedFalsePositive += result.stage1.verifiedFalsePositive;
  totals.inputTokens += result.inputTokens;
  totals.outputTokens += result.outputTokens;
  totals.modelCallCount += result.benchmark?.reliability?.callsStarted ?? result.coverage?.callsStarted ?? 0;
  totals.latencies.push(result.durationMs);
  const executionStatus = result.executionStatus ?? result.status;
  totals.partialRuns += executionStatus === "completed" ? 0 : 1;
  totals.runs += 1;
  for (const [key, value] of Object.entries(result.stage1.attributions) as Array<[Stage1Attribution, number]>)
    totals.attributions[key] += value;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values: number[]): number | null {
  const average = mean(values);
  return average === null
    ? null
    : Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function summarizeTotals(totals: Totals): Stage1MetricSummary {
  return {
    selectionRecall: ratio(totals.selectedGold, totals.eligibleGold),
    candidateFindingRecall: ratio(totals.candidateTruePositive, totals.eligibleGold),
    candidateFindingPrecision:
      ratio(totals.candidateTruePositive, totals.candidateTruePositive + totals.candidateFalsePositive) ??
      (totals.eligibleGold ? 0 : 1),
    verifiedFindingRecall: ratio(totals.verifiedTruePositive, totals.eligibleGold),
    verifiedFindingPrecision:
      ratio(totals.verifiedTruePositive, totals.verifiedTruePositive + totals.verifiedFalsePositive) ??
      (totals.eligibleGold ? 0 : 1),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.inputTokens + totals.outputTokens,
    modelCallCount: totals.modelCallCount,
    latencyMeanMs: mean(totals.latencies),
    latencyStdDevMs: standardDeviation(totals.latencies),
    partialReviewRate: ratio(totals.partialRuns, totals.runs),
    runs: totals.runs,
    attributions: totals.attributions,
  };
}

function averageSummaries(values: Stage1MetricSummary[]): Stage1MetricSummary {
  const average = (key: keyof Stage1MetricSummary) => {
    const numbers = values.flatMap((value) => (typeof value[key] === "number" ? [value[key] as number] : []));
    return mean(numbers);
  };
  const attributions = emptyTotals().attributions;
  for (const summary of values)
    for (const [key, value] of Object.entries(summary.attributions) as Array<[Stage1Attribution, number]>)
      attributions[key] += value;
  return {
    selectionRecall: average("selectionRecall"),
    candidateFindingRecall: average("candidateFindingRecall"),
    candidateFindingPrecision: average("candidateFindingPrecision"),
    verifiedFindingRecall: average("verifiedFindingRecall"),
    verifiedFindingPrecision: average("verifiedFindingPrecision"),
    inputTokens: average("inputTokens") ?? 0,
    outputTokens: average("outputTokens") ?? 0,
    totalTokens: average("totalTokens") ?? 0,
    modelCallCount: average("modelCallCount") ?? 0,
    latencyMeanMs: average("latencyMeanMs"),
    latencyStdDevMs: average("latencyStdDevMs"),
    partialReviewRate: average("partialReviewRate"),
    runs: values.reduce((sum, value) => sum + value.runs, 0),
    attributions,
  };
}

export function aggregateStage1Metrics(report: Stage1EvalReport) {
  const microTotals = emptyTotals();
  const familyTotals = new Map<string, Totals>();
  for (const evalCase of report.cases) {
    if (evalCase.kind === "conformance") continue;
    const family = evalCase.contractFamily ?? evalCase.id;
    const totals = familyTotals.get(family) ?? emptyTotals();
    familyTotals.set(family, totals);
    for (const result of evalCase.results) {
      addResult(microTotals, result);
      addResult(totals, result);
    }
  }
  const byContractFamily = Object.fromEntries(
    [...familyTotals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([family, totals]) => [
      family,
      summarizeTotals(totals),
    ]),
  );
  return {
    micro: summarizeTotals(microTotals),
    contractFamilyMacro: averageSummaries(Object.values(byContractFamily)),
    byContractFamily,
  };
}

export interface Stage1Baseline {
  schemaVersion: 1;
  stage: 1;
  corpusHash: string;
  modes: string[];
  evidence: {
    stageReplay: { repetitions: 2; deterministic: true; reportHash: string };
    live: { repetitions: 3; harnessErrors: 0; reportHash: string };
  };
  metrics: ReturnType<typeof aggregateStage1Metrics>;
}

function stableValue(value: unknown, omitVolatile = false): unknown {
  if (Array.isArray(value))
    return value
      .filter(
        (item) =>
          !(
            omitVolatile &&
            item &&
            typeof item === "object" &&
            ["wallMs", "providerMs"].includes(String((item as Record<string, unknown>).name))
          ),
      )
      .map((item) => stableValue(item, omitVolatile));
  if (!value || typeof value !== "object") return value;
  const volatile = new Set(["createdAt", "directory", "durationMs", "elapsedMs", "iteration", "markdown", "runId"]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !(omitVolatile &&
            (volatile.has(key) ||
              /duration.*ms$/i.test(key) ||
              key.endsWith("ProviderMs") ||
              key === "wallMs" ||
              key === "reviewedChangedLinesPerSecond")),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item, omitVolatile)]),
  );
}

function stableJson(value: unknown, omitVolatile = false): string {
  return JSON.stringify(stableValue(value, omitVolatile));
}

function digest(value: unknown, omitVolatile = false): string {
  return crypto.createHash("sha256").update(stableJson(value, omitVolatile)).digest("hex");
}

function reportErrors(report: Stage1EvalReport): string[] {
  return report.cases.flatMap((evalCase) =>
    evalCase.results.flatMap((result) => [...result.errors, ...(result.incompatibilities ?? [])]),
  );
}

function groupedResults(report: Stage1EvalReport): Map<string, Stage1ReportResult[]> {
  const groups = new Map<string, Stage1ReportResult[]>();
  for (const evalCase of report.cases)
    for (const result of evalCase.results) {
      const key = `${evalCase.id}\u0000${result.mode}`;
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
  return groups;
}

function assertReportShape(report: Stage1EvalReport, replay: "stage" | "live", repetitions: 2 | 3): void {
  if (report.replay !== replay) throw new Error(`Expected ${replay} eval report, got ${report.replay}`);
  if (report.repeat !== repetitions) throw new Error(`${replay} eval report must declare exactly ${repetitions} repetitions`);
  if (reportErrors(report).length) throw new Error(`${replay} eval report contains harness errors or incompatibilities`);
  if (!report.cases.length || new Set(report.cases.map((item) => item.id)).size !== report.cases.length)
    throw new Error(`${replay} eval report must contain uniquely identified cases`);
  if (!report.modes.length || new Set(report.modes).size !== report.modes.length)
    throw new Error(`${replay} eval report must declare unique modes`);
  const groups = groupedResults(report);
  if (!groups.size) throw new Error(`${replay} eval report has no case/mode results`);
  const expectedKeys = report.cases.flatMap((evalCase) => report.modes.map((mode) => `${evalCase.id}\u0000${mode}`));
  if (stableJson([...groups.keys()].sort()) !== stableJson(expectedKeys.sort()))
    throw new Error(`${replay} eval report does not contain the complete case/mode matrix`);
  for (const [key, results] of groups) {
    if (results.length !== repetitions)
      throw new Error(`${replay} eval report ${key.replace("\u0000", ":")} must contain exactly ${repetitions} results`);
    const iterations = results.map((result) => result.iteration).sort((left, right) => left - right);
    if (stableJson(iterations) !== stableJson(Array.from({ length: repetitions }, (_, index) => index)))
      throw new Error(`${replay} eval report ${key.replace("\u0000", ":")} has invalid repetitions`);
    if (results.some((result) => !result.stage1))
      throw new Error(`${replay} eval report ${key.replace("\u0000", ":")} lacks Stage 1 metrics`);
  }
}

function assertDeterministicStageReplay(report: Stage1EvalReport): void {
  for (const [key, results] of groupedResults(report)) {
    const semantic = results.map((result) => stableJson(result, true));
    if (new Set(semantic).size !== 1)
      throw new Error(`Stage replay is not deterministic for ${key.replace("\u0000", ":")}`);
  }
}

function reportKeys(report: Stage1EvalReport): string[] {
  return [...groupedResults(report).keys()].sort();
}

export function summarizeStage1Baseline(stageResult: Stage1EvalReport, liveResult: Stage1EvalReport): Stage1Baseline {
  if (stageResult.corpusHash !== liveResult.corpusHash) throw new Error("Stage and live reports use different corpus hashes");
  assertReportShape(stageResult, "stage", 2);
  assertReportShape(liveResult, "live", 3);
  if (stableJson(reportKeys(stageResult)) !== stableJson(reportKeys(liveResult)))
    throw new Error("Stage and live reports cover different cases or modes");
  assertDeterministicStageReplay(stageResult);
  return {
    schemaVersion: 1,
    stage: 1,
    corpusHash: stageResult.corpusHash,
    modes: [...liveResult.modes].sort(),
    evidence: {
      stageReplay: { repetitions: 2, deterministic: true, reportHash: digest(stageResult, true) },
      live: { repetitions: 3, harnessErrors: 0, reportHash: digest(liveResult, true) },
    },
    metrics: aggregateStage1Metrics(liveResult),
  };
}

export function serializeStage1Baseline(baseline: Stage1Baseline): string {
  return `${JSON.stringify(stableValue(baseline), null, 2)}\n`;
}

export function readStage1Baseline(file: string): Stage1Baseline {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Stage1Baseline;
}

export function writeStage1Baseline(file: string, baseline: Stage1Baseline): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeStage1Baseline(baseline), { encoding: "utf8", mode: 0o600 });
}

export interface Stage1PromotionValidation {
  ok: boolean;
  errors: string[];
}

export function validateStage1Promotion(input: {
  baseline: Stage1Baseline;
  currentCorpusHash: string;
}): Stage1PromotionValidation {
  const { baseline } = input;
  const errors: string[] = [];
  if (baseline.schemaVersion !== 1 || baseline.stage !== 1) errors.push("baseline is not a Stage 1 baseline");
  if (!/^[a-f0-9]{64}$/.test(baseline.corpusHash)) errors.push("baseline corpus hash is invalid");
  if (baseline.corpusHash !== input.currentCorpusHash) errors.push("baseline corpus hash does not match current corpus");
  if (baseline.evidence?.stageReplay?.repetitions !== 2 || !baseline.evidence?.stageReplay?.deterministic)
    errors.push("deterministic two-repetition stage replay evidence is missing");
  if (baseline.evidence?.live?.repetitions !== 3 || baseline.evidence?.live?.harnessErrors !== 0)
    errors.push("error-free three-repetition live evidence is missing");
  if (!/^[a-f0-9]{64}$/.test(baseline.evidence?.stageReplay?.reportHash ?? ""))
    errors.push("stage replay evidence hash is missing or invalid");
  if (!/^[a-f0-9]{64}$/.test(baseline.evidence?.live?.reportHash ?? ""))
    errors.push("live evidence hash is missing or invalid");
  const required = [
    "selectionRecall",
    "candidateFindingRecall",
    "candidateFindingPrecision",
    "verifiedFindingRecall",
    "verifiedFindingPrecision",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "modelCallCount",
    "latencyMeanMs",
    "latencyStdDevMs",
    "partialReviewRate",
  ] as const;
  for (const summary of [baseline.metrics?.micro, baseline.metrics?.contractFamilyMacro])
    for (const name of required)
      if (typeof summary?.[name] !== "number" || !Number.isFinite(summary[name]))
        errors.push(`required metric ${name} is missing or non-numeric`);
  if (!Object.keys(baseline.metrics?.byContractFamily ?? {}).length) errors.push("contract-family metrics are missing");
  if (!baseline.modes?.length) errors.push("baseline modes are missing");
  return { ok: errors.length === 0, errors };
}
