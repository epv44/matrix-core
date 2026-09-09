import type { ReviewResult } from "../../../src/core/types.js";
import type { EngineExecution, ReviewWorkItem } from "../../../src/agentsmith/engine-types.js";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import type { EvalCase } from "./case.js";
import { findingMatches } from "./matching.js";
import { riskScore } from "../../../src/agentsmith/projection.js";
import { collectCandidateNearMissDiagnostics } from "./candidate-diagnostics.js";

export type EvalStage =
  | "snapshot"
  | "graph"
  | "planning"
  | "ranking"
  | "selection"
  | "projection"
  | "candidates"
  | "evidence"
  | "verification"
  | "aggregation"
  | "reporting";

export interface StageMetric {
  name: string;
  value: number | boolean | null;
  numerator?: number;
  denominator?: number;
  direction: "higher" | "lower" | "exact";
}

export interface StageEvaluation {
  stage: EvalStage;
  evaluation: "executed" | "observed" | "incompatible" | "not-applicable" | "not-evaluable";
  causalStatus?: "healthy" | "root-failure" | "downstream-blocked";
  blockedBy?: EvalStage[];
  metrics: StageMetric[];
  diagnostics: string[];
  /** Informational near-miss details; never used for causal status. */
  diagnosticOnly?: string[];
}

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);
const metric = (
  name: string,
  numerator: number,
  denominator: number,
  direction: StageMetric["direction"] = "higher",
): StageMetric => ({ name, numerator, denominator, value: ratio(numerator, denominator), direction });

export interface PlanningRiskRankingScore {
  ordered: number | null;
  mustOutrank: number | null;
  degreeOrdering: number | null;
  expectedEdges: number | null;
  priorityAssertions: number | null;
  diagnostics: string[];
  rankedIds: string[];
}

type RiskRankingExpectation = NonNullable<NonNullable<EvalCase["expectations"]["planning"]>["riskRanking"]>;

type PlannerManifestItem = NonNullable<EngineExecution["plannerManifest"]>[number];
type PlanningItem = ReviewWorkItem | PlannerManifestItem;

function workItemKey(item: PlanningItem): string[] {
  if ("primarySymbols" in item)
    return [
      item.id,
      ...item.primarySymbols.flatMap((symbol) => [symbol.name, symbol.qualifiedName, `${symbol.file}#${symbol.qualifiedName}`]),
      ...item.relatedSymbols.flatMap((symbol) => [symbol.name, symbol.qualifiedName, `${symbol.file}#${symbol.qualifiedName}`]),
    ];
  return [
    item.id,
    ...item.symbols.flatMap((symbol) => [symbol, symbol.replace("#", ":")]),
  ];
}

function riskRank(left: PlanningItem, right: PlanningItem): number {
  const lf = left.rankFactors;
  const rf = right.rankFactors;
  return (
    riskScore({ priority: right.priority, rankFactors: rf }) - riskScore({ priority: left.priority, rankFactors: lf }) ||
    (rf?.productionSurface ?? 0) - (lf?.productionSurface ?? 0) ||
    (rf?.changedEndpoints ?? 0) - (lf?.changedEndpoints ?? 0) ||
    (rf?.edgeRisk ?? 0) - (lf?.edgeRisk ?? 0) ||
    (rf?.changedLines ?? 0) - (lf?.changedLines ?? 0) ||
    left.kind.localeCompare(right.kind) ||
    riskSemanticKey(left).localeCompare(riskSemanticKey(right))
  );
}

function riskSemanticKey(item: PlanningItem): string {
  if (!("primarySymbols" in item)) return [item.kind, ...item.symbols, ...item.edges].join("|");
  return [
    item.kind,
    ...item.primarySymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
    ...item.relatedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
    ...item.graphEdges.map((edge) => edge.kind),
  ].join("|");
}

/** Score planner ordering only. Selection limits and selected work items are
 * deliberately not part of this function's inputs. */
export function scorePlanningRiskRanking(
  expectation: RiskRankingExpectation,
  workItems: PlanningItem[],
): PlanningRiskRankingScore {
  const ranked = [...workItems].sort(riskRank);
  const byKey = new Map<string, PlanningItem>();
  for (const item of ranked)
    for (const key of workItemKey(item))
      if (!byKey.has(key)) byKey.set(key, item);
  const positions = new Map(ranked.map((item, index) => [item.id, index]));
  const diagnostics: string[] = [];
  const resolve = (key: string) => {
    const item = byKey.get(key);
    if (!item) diagnostics.push(`missing risk-ranked unit ${key}`);
    return item;
  };

  let orderedMatched = 0;
  let orderedTotal = 0;
  for (let index = 0; index < Math.max(0, expectation.ordered.length - 1); index += 1) {
    const higher = resolve(expectation.ordered[index]);
    const lower = resolve(expectation.ordered[index + 1]);
    if (!higher || !lower) continue;
    orderedTotal += 1;
    if ((positions.get(higher.id) ?? Infinity) < (positions.get(lower.id) ?? -1)) orderedMatched += 1;
    else diagnostics.push(`risk order violated ${expectation.ordered[index]} > ${expectation.ordered[index + 1]}`);
  }
  let outrankMatched = 0;
  let outrankTotal = 0;
  for (const pair of expectation.mustOutrank) {
    const higher = resolve(pair.higher);
    const lower = resolve(pair.lower);
    if (!higher || !lower) continue;
    outrankTotal += 1;
    if ((positions.get(higher.id) ?? Infinity) < (positions.get(lower.id) ?? -1)) outrankMatched += 1;
    else diagnostics.push(`risk order violated ${pair.higher} > ${pair.lower}`);
  }
  let degreeMatched = 0;
  let degreeTotal = 0;
  for (const pair of expectation.degreePairs ?? []) {
    const higher = resolve(pair.higher);
    const lower = resolve(pair.lower);
    if (!higher || !lower) continue;
    degreeTotal += 1;
    const higherDegree = higher.rankFactors?.graphDegree ?? 0;
    const lowerDegree = lower.rankFactors?.graphDegree ?? 0;
    if (higherDegree > lowerDegree && (positions.get(higher.id) ?? Infinity) < (positions.get(lower.id) ?? -1)) degreeMatched += 1;
    else diagnostics.push(`degree order violated ${pair.higher} > ${pair.lower}`);
  }
  const actualEdges = new Set(
    ranked.flatMap((item) =>
      "graphEdges" in item
        ? item.graphEdges.map((edge) => `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`)
        : item.edges,
    ),
  );
  const edgeMatched = expectation.expectedEdges.filter((edge) =>
    actualEdges.has(`${edge.source}->${edge.target}:${edge.kind}`),
  );
  diagnostics.push(...expectation.expectedEdges
    .filter((edge) => !edgeMatched.includes(edge))
    .map((edge) => `missing risk edge ${edge.source}->${edge.target}:${edge.kind}`));

  let priorityMatched = 0;
  let priorityTotal = 0;
  for (const assertion of expectation.units) {
    const item = resolve(assertion.id);
    if (!item) continue;
    if (assertion.minPriority !== undefined) {
      priorityTotal += 1;
      if ((item.priority ?? 0) >= assertion.minPriority) priorityMatched += 1;
      else diagnostics.push(`priority below minimum for ${assertion.id}`);
    }
    for (const [factor, minimum] of Object.entries(assertion.factors ?? {})) {
      priorityTotal += 1;
      const actual = item.rankFactors?.[factor as keyof NonNullable<ReviewWorkItem["rankFactors"]>] ?? 0;
      if (actual >= minimum) priorityMatched += 1;
      else diagnostics.push(`rank factor ${factor} below minimum for ${assertion.id}`);
    }
  }
  return {
    ordered: ratio(orderedMatched, orderedTotal),
    mustOutrank: ratio(outrankMatched, outrankTotal),
    degreeOrdering: ratio(degreeMatched, degreeTotal),
    expectedEdges: ratio(edgeMatched.length, expectation.expectedEdges.length),
    priorityAssertions: ratio(priorityMatched, priorityTotal),
    diagnostics,
    rankedIds: ranked.map((item) => item.id),
  };
}

type Inspection = { files: Set<string>; symbols: Set<string>; edges: Set<string> };

type GraphManifest = NonNullable<EngineExecution["graphManifest"]>;

function canonicalGraphEdgeKey(edge: { source: string; target: string | null; targetText?: string; kind: string }) {
  return `${edge.kind}:${edge.source}:${edge.target ?? edge.targetText ?? ""}`;
}

function graphNodeKey(value: string) {
  return value.replace("#", ":");
}

function graphEdgeEndpoints(value: string): { source: string; target: string; kind: string } | null {
  const match = /^(.*)->(.*):([^:]+)$/.exec(value);
  return match ? { source: match[1], target: match[2], kind: match[3] } : null;
}

function canonicalGraphEdges(manifest: GraphManifest | undefined) {
  const unique = new Map<string, GraphManifest["edges"][number]>();
  for (const edge of manifest?.edges ?? []) unique.set(canonicalGraphEdgeKey(edge), edge);
  return [...unique.values()].filter((edge) => edge.target && edge.source !== edge.target);
}

function graphNeighbors(manifest: GraphManifest | undefined) {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of canonicalGraphEdges(manifest)) {
    const source = edge.source;
    const target = edge.target!;
    const sourceNeighbors = neighbors.get(source) ?? new Set<string>();
    const targetNeighbors = neighbors.get(target) ?? new Set<string>();
    sourceNeighbors.add(target);
    targetNeighbors.add(source);
    neighbors.set(source, sourceNeighbors);
    neighbors.set(target, targetNeighbors);
  }
  return neighbors;
}

function graphFactorValues(manifest: GraphManifest | undefined, node: string) {
  const canonical = canonicalGraphEdges(manifest);
  const incoming = new Set(canonical.filter((edge) => edge.target === node).map((edge) => edge.source));
  const outgoing = new Set(canonical.filter((edge) => edge.source === node).map((edge) => edge.target!));
  return {
    fanIn: incoming.size,
    fanOut: outgoing.size,
    neighborDegree: new Set([...incoming, ...outgoing]).size,
    directedIncidentDegree: incoming.size + outgoing.size,
  };
}

type GraphTargets = NonNullable<EvalCase["expectations"]["graph"]>;

function graphContractMetrics(targets: GraphTargets, manifest: GraphManifest | undefined) {
  const graphScope = targets.graphScope ?? { exhaustiveNodes: [], highDegreeThreshold: 3 };
  const adjacency = targets.adjacency ?? [];
  const graphFactors = targets.graphFactors ?? [];
  const expectedEdges = targets.edges ?? [];
  const hasLabeledScope = Boolean(
    graphScope.exhaustiveNodes.length || adjacency.length || graphFactors.length,
  );
  const actualEdges = canonicalGraphEdges(manifest);
  const actualEdgeKeys = new Set(actualEdges.map((edge) => canonicalGraphEdgeKey(edge)));
  const expectedEdgeRows = expectedEdges
    .map(graphEdgeEndpoints)
    .filter((edge): edge is { source: string; target: string; kind: string } => Boolean(edge));
  const expectedEdgeKeys = new Set(expectedEdgeRows.map((edge) => `${edge.kind}:${edge.source}:${edge.target}`));
  const scopeNodes = new Set([
    ...graphScope.exhaustiveNodes.map(graphNodeKey),
    ...adjacency.filter((item) => item.exhaustive).map((item) => graphNodeKey(item.node)),
    ...graphFactors.map((item) => graphNodeKey(item.node)),
  ]);
  if (!hasLabeledScope) {
    return {
      metrics: [
        metric("microEdgeRecall", 0, 0),
        metric("microEdgePrecision", 0, 0),
        { name: "missingEdgeCount", value: null, direction: "lower" },
        { name: "unexpectedEdgeCount", value: null, direction: "lower" },
        metric("microAdjacencyRecall", 0, 0),
        { name: "macroAdjacencyRecall", value: null, direction: "higher" },
        { name: "minimumNodeAdjacencyRecall", value: null, direction: "higher" },
        metric("emptyAdjacencyExact", 0, 0),
        metric("fanInAccuracy", 0, 0),
        metric("fanOutAccuracy", 0, 0),
        metric("neighborDegreeAccuracy", 0, 0),
        metric("directedIncidentDegreeAccuracy", 0, 0),
        metric("highDegreeNodeRecall", 0, 0),
      ] as StageMetric[],
      diagnostics: [],
    };
  }
  const scopedActual = scopeNodes.size
    ? actualEdges.filter((edge) => scopeNodes.has(edge.source) || scopeNodes.has(edge.target!))
    : [];
  const scopedActualKeys = new Set(scopedActual.map((edge) => canonicalGraphEdgeKey(edge)));
  const scopedExpectedKeys = new Set(
    expectedEdgeRows
      .filter((edge) => scopeNodes.has(edge.source) || scopeNodes.has(edge.target))
      .map((edge) => `${edge.kind}:${edge.source}:${edge.target}`),
  );
  const truePositive = [...scopedExpectedKeys].filter((edge) => actualEdgeKeys.has(edge)).length;
  const falseNegative = scopedExpectedKeys.size - truePositive;
  const falsePositive = [...scopedActualKeys].filter((edge) => !scopedExpectedKeys.has(edge)).length;
  const metrics: StageMetric[] = [
    metric("microEdgeRecall", truePositive, expectedEdgeKeys.size),
    metric("microEdgePrecision", truePositive, truePositive + falsePositive),
    { name: "missingEdgeCount", value: falseNegative, direction: "lower" },
    { name: "unexpectedEdgeCount", value: falsePositive, direction: "lower" },
  ];
  const diagnostics = [
    ...[...scopedExpectedKeys].filter((edge) => !actualEdgeKeys.has(edge)).map((edge) => `missing canonical edge ${edge}`),
    ...[...scopedActualKeys].filter((edge) => !scopedExpectedKeys.has(edge)).map((edge) => `unexpected canonical edge ${edge}`),
  ];
  const neighbors = graphNeighbors(manifest);
  const adjacencyRows = adjacency.filter((item) => item.exhaustive);
  const applicableAdjacency = adjacencyRows.filter((item) => item.expectedNeighbors.length > 0);
  const adjacencyMatches = applicableAdjacency.map((item) => {
    const expected = new Set(item.expectedNeighbors.map(graphNodeKey));
    const actual = neighbors.get(graphNodeKey(item.node)) ?? new Set<string>();
    return { matched: [...expected].filter((neighbor) => actual.has(neighbor)).length, expected: expected.size };
  });
  metrics.push(
    metric("microAdjacencyRecall", adjacencyMatches.reduce((sum, item) => sum + item.matched, 0), adjacencyMatches.reduce((sum, item) => sum + item.expected, 0)),
    {
      name: "macroAdjacencyRecall",
      value: adjacencyMatches.length ? adjacencyMatches.reduce((sum, item) => sum + item.matched / item.expected, 0) / adjacencyMatches.length : null,
      direction: "higher",
    },
    {
      name: "minimumNodeAdjacencyRecall",
      value: adjacencyMatches.length ? Math.min(...adjacencyMatches.map((item) => item.matched / item.expected)) : null,
      direction: "higher",
    },
  );
  const emptyAdjacency = adjacencyRows.filter((item) => item.expectedNeighbors.length === 0);
  const emptyExact = emptyAdjacency.filter((item) => (neighbors.get(graphNodeKey(item.node))?.size ?? 0) === 0).length;
  metrics.push(metric("emptyAdjacencyExact", emptyExact, emptyAdjacency.length));
  const factorRows = graphFactors.map((expected) => {
    const actual = graphFactorValues(manifest, graphNodeKey(expected.node));
    return { expected, actual };
  });
  for (const name of ["fanIn", "fanOut", "neighborDegree", "directedIncidentDegree"] as const) {
    const matched = factorRows.filter((row) => row.actual[name] === row.expected[name]).length;
    metrics.push(metric(`${name}Accuracy`, matched, factorRows.length));
  }
  const highDegree = factorRows.filter((row) => row.expected.neighborDegree >= graphScope.highDegreeThreshold);
  const highDegreeMatched = highDegree.filter((row) => row.actual.neighborDegree === row.expected.neighborDegree).length;
  metrics.push(metric("highDegreeNodeRecall", highDegreeMatched, highDegree.length));
  return { metrics, diagnostics };
}

function inspectedItems(items: PlanningItem[]): Inspection {
  return {
    files: new Set(
      items.flatMap((item) => ("primarySymbols" in item ? item.code.map((snippet) => snippet.file) : item.files)),
    ),
    symbols: new Set(
      items.flatMap((item) =>
        "primarySymbols" in item
          ? [...item.primarySymbols, ...item.relatedSymbols].flatMap((symbol) => [
              symbol.name,
              symbol.qualifiedName,
              `${symbol.file}#${symbol.qualifiedName}`,
            ])
          : item.symbols.flatMap((symbol) => [symbol, symbol.replace("#", ":")]),
      ),
    ),
    edges: new Set(
      items.flatMap((item) =>
        "primarySymbols" in item
          ? item.graphEdges.flatMap((edge) => [
              `${edge.source}->${edge.target ?? edge.targetText}`,
              `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
            ])
          : item.edges,
      ),
    ),
  };
}

function planningFactorMetrics(labels: NonNullable<EvalCase["expectations"]["planning"]>, items: PlanningItem[]) {
  const expected = labels.graphFactors ?? [];
  const factorNames = ["fanIn", "fanOut", "neighborDegree", "directedIncidentDegree"] as const;
  if (!expected.length) {
    return [
      metric("riskFactorAvailability", 0, 0),
      metric("riskFactorValueAccuracy", 0, 0),
      metric("graphFactorCoverage", 0, 0),
    ];
  }
  const rows = expected.map((row) => {
    const nodeKey = row.node.replace("#", ":");
    const matching = items.filter((item) => workItemKey(item).some((key) => key === row.node || key === nodeKey));
    // A local unit carries the node's own factors. Interaction units may
    // intentionally aggregate the primary and related node factors for
    // interaction risk, so they are not the node-factor oracle.
    const actual = matching.find((item) => item.kind === "local") ?? matching[0];
    const factors = actual?.rankFactors;
    const values = {
      fanIn: factors?.fanIn,
      fanOut: factors?.fanOut,
      neighborDegree: factors?.neighborDegree ?? factors?.graphDegree,
      directedIncidentDegree: factors?.directedIncidentDegree,
    };
    return { row, values };
  });
  const available = rows.reduce(
    (count, row) => count + factorNames.filter((name) => typeof row.values[name] === "number").length,
    0,
  );
  const correct = rows.flatMap(({ row, values }) => factorNames.map((name) => values[name] === row[name])).filter(Boolean).length;
  const completeRows = rows.filter(({ values }) => factorNames.every((name) => typeof values[name] === "number")).length;
  return [
    metric("riskFactorAvailability", available, expected.length * factorNames.length),
    metric("riskFactorValueAccuracy", correct, expected.length * factorNames.length),
    metric("graphFactorCoverage", completeRows, expected.length),
  ];
}

function graphInspected(execution: EngineExecution): Inspection {
  const manifest = execution.graphManifest;
  if (!manifest) return { files: new Set(), symbols: new Set(), edges: new Set() };
  return {
    files: new Set([...manifest.changedSymbols, ...manifest.nodes].map((symbol) => symbol.file)),
    symbols: new Set(
      [...manifest.changedSymbols, ...manifest.nodes].flatMap((symbol) => [
        symbol.name,
        symbol.qualifiedName,
        `${symbol.file}#${symbol.qualifiedName}`,
      ]),
    ),
    edges: new Set(
      manifest.edges.flatMap((edge) => [
        `${edge.source}->${edge.target ?? edge.targetText}`,
        `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
      ]),
    ),
  };
}

function canonicalChangeKinds(trace: AgentSmithTrace): Map<string, string> {
  const kinds = new Map(trace.scope.manifest.map((item) => [item.path, item.changeKind as string]));
  let current: string | undefined;
  for (const line of trace.scope.diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      kinds.set(current, header[1] === header[2] ? "modified" : "renamed");
    } else if (current && line.startsWith("new file mode ")) kinds.set(current, "added");
    else if (current && line.startsWith("deleted file mode ")) kinds.set(current, "deleted");
  }
  return kinds;
}

function targetMetrics(
  targets: {
    files: string[];
    symbols: string[];
    edges: string[];
    forbiddenFiles: string[];
    forbiddenSymbols: string[];
    forbiddenEdges: string[];
  },
  actual: Inspection,
) {
  const normalized = {
    files: targets.files ?? [],
    symbols: targets.symbols ?? [],
    edges: targets.edges ?? [],
    forbiddenFiles: targets.forbiddenFiles ?? [],
    forbiddenSymbols: targets.forbiddenSymbols ?? [],
    forbiddenEdges: targets.forbiddenEdges ?? [],
  };
  return (["files", "symbols", "edges"] as const).map((kind) => {
    const matched = normalized[kind].filter((target) => actual[kind].has(target));
    const forbiddenKey = `forbidden${kind[0].toUpperCase()}${kind.slice(1)}` as
      "forbiddenFiles" | "forbiddenSymbols" | "forbiddenEdges";
    const forbidden = normalized[forbiddenKey].filter((target) => actual[kind].has(target));
    return {
      metric: metric(`${kind}Recall`, matched.length, normalized[kind].length),
      forbiddenMetric: {
        name: `forbidden${kind[0].toUpperCase()}${kind.slice(1)}`,
        value: forbidden.length,
        direction: "lower" as const,
      },
      missing: normalized[kind].filter((target) => !actual[kind].has(target)),
      forbidden,
    };
  });
}

function graphPathExists(
  execution: EngineExecution,
  expected: { from: string; to: string; maxHops: number; edgeKinds: string[] },
): boolean {
  const edges = execution.graphManifest?.edges ?? [];
  const queue: Array<{ node: string; hops: number }> = [{ node: expected.from, hops: 0 }];
  const visited = new Set([expected.from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.node === expected.to) return true;
    if (current.hops >= expected.maxHops) continue;
    for (const edge of edges) {
      if (edge.source !== current.node || (expected.edgeKinds.length && !expected.edgeKinds.includes(edge.kind)))
        continue;
      const target = edge.target ?? edge.targetText;
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push({ node: target, hops: current.hops + 1 });
    }
  }
  return false;
}

type CandidateExpectation = NonNullable<EvalCase["expectations"]["candidates"]>["items"][number];

function candidateMatches(
  actual: { file: string; line: number; endLine?: number; category: string; severity?: string; title: string },
  expected: CandidateExpectation,
) {
  const end = actual.endLine ?? actual.line;
  if (actual.file !== expected.file || end < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  if (expected.severity && actual.severity !== expected.severity) return false;
  return !expected.titleContains || actual.title.toLowerCase().includes(expected.titleContains.toLowerCase());
}

function candidateExpectations(definition: EvalCase): CandidateExpectation[] {
  return definition.expectations.verification?.candidates ?? definition.expectations.candidates?.items ?? [];
}

export function evaluateStages(opts: {
  definition: EvalCase;
  trace: AgentSmithTrace;
  execution: EngineExecution;
  result: Pick<ReviewResult, "findings" | "status" | "coverage"> & {
    outcome: ReviewResult["outcome"] | null;
  };
  tier: "stage" | "recorded" | "isolated" | "live";
  hermetic: boolean;
  selected?: EvalStage[];
  candidateExecution?: EngineExecution;
  /** Complete planner output, before selection limits are applied. */
  planningWorkItems?: PlanningItem[];
  /** Frozen ranking input supplied by an isolated fixture, when available. */
  rankingWorkItems?: PlanningItem[];
  /** Frozen graph manifest supplied by an isolated fixture, when available. */
  graphManifest?: EngineExecution["graphManifest"];
  /** Frozen ranked IDs used to audit the Ranking-to-Selection boundary. */
  selectionInput?: { rankedWorkItemIds: string[] };
  reportMarkdown?: string;
}): StageEvaluation[] {
  const { definition, trace, execution, result } = opts;
  const chosen = new Set<EvalStage>(
    opts.selected ?? [
      "snapshot",
      "graph",
      "planning",
      "ranking",
      "selection",
      "projection",
      "candidates",
      "evidence",
      "verification",
      "aggregation",
      "reporting",
    ],
  );
  const evaluation = (stage: EvalStage) => {
    if (stage === "snapshot") return "observed" as const;
    if (opts.tier === "stage" && ["graph", "projection", "planning", "ranking", "selection"].includes(stage))
      return opts.hermetic ? ("executed" as const) : ("observed" as const);
    return "executed" as const;
  };
  const values: StageEvaluation[] = [];
  const stageOrder: EvalStage[] = [
    "snapshot",
    "graph",
    "planning",
    "ranking",
    "selection",
    "projection",
    "candidates",
    "evidence",
    "verification",
    "aggregation",
    "reporting",
  ];
  const causalFailures = new Map<EvalStage, StageEvaluation>();
  const push = (value: StageEvaluation) => {
    if (!chosen.has(value.stage)) return;
    const causalDiagnostics = value.diagnostics.filter(
      (diagnostic) => !value.diagnosticOnly?.includes(diagnostic),
    );
    const prior = stageOrder.slice(0, stageOrder.indexOf(value.stage)).find((stage) => causalFailures.has(stage));
    const isolatedComponentRun = opts.tier === "isolated" && ["graph", "planning", "ranking", "selection"].includes(value.stage);
    if (prior && !value.causalStatus && !isolatedComponentRun && !(value.stage === "evidence" && opts.tier === "isolated")) {
      value = {
        ...value,
        causalStatus: "downstream-blocked",
        blockedBy: [prior],
        diagnostics: [...value.diagnostics, `blocked by ${prior} root-failure`],
      };
    } else if (
      !value.causalStatus &&
      !["not-applicable", "not-evaluable"].includes(value.evaluation) &&
      causalDiagnostics.length
    ) {
      value = { ...value, causalStatus: "root-failure" };
    } else if (!value.causalStatus && !["not-applicable", "not-evaluable"].includes(value.evaluation)) {
      value = { ...value, causalStatus: "healthy" };
    }
    if (value.causalStatus === "root-failure") causalFailures.set(value.stage, value);
    values.push(value);
  };

  const snapshot = definition.expectations.snapshot;
  if (!snapshot) push({ stage: "snapshot", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
  else {
    const actual = canonicalChangeKinds(trace);
    const matched = snapshot.files.filter(
      (item) => actual.get(item.path) && (!item.changeKind || actual.get(item.path) === item.changeKind),
    );
    push({
      stage: "snapshot",
      evaluation: evaluation("snapshot"),
      metrics: [
        metric("fileRecall", matched.length, snapshot.files.length),
        metric("filePrecision", matched.length, actual.size),
        {
          name: "fixtureValidated",
          value: opts.hermetic,
          direction: "exact",
        },
      ] as StageMetric[],
      diagnostics: [
        ...snapshot.files.filter((item) => !matched.includes(item)).map((item) => `missing ${item.path}`),
        ...(matched.length !== actual.size ? [`snapshot precision ${matched.length}/${actual.size} is not exact`] : []),
      ],
    });
  }

  for (const stage of ["graph"] as const) {
    const targets = definition.expectations[stage];
    if (!targets) {
      push({ stage, evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
      continue;
    }
    const actual = graphInspected({ ...execution, graphManifest: opts.graphManifest ?? execution.graphManifest });
    const scored = targetMetrics(targets, actual);
    const metrics = scored.flatMap((item) => [item.metric, item.forbiddenMetric]);
    const diagnostics = scored.flatMap((item) => [
      ...item.missing.map((target) => `missing ${target}`),
      ...item.forbidden.map((target) => `forbidden ${target}`),
    ]);
    if (stage === "graph") {
      const paths = targets.paths ?? [];
      const matchedPaths = paths.filter((item) => graphPathExists(execution, item));
      metrics.push(metric("pathRecall", matchedPaths.length, targets.paths.length));
      const exactEdges = new Set(
        (execution.graphManifest?.edges ?? [])
          .filter((edge) => edge.target !== null && edge.confidence === "exact")
          .map((edge) => `${edge.source}->${edge.target}:${edge.kind}`),
      );
      metrics.push(
        metric(
          "labeledExactEdgeRate",
          targets.edges.filter((edge) => exactEdges.has(edge)).length,
          targets.edges.length,
        ),
      );
      metrics.push({
        name: "unresolvedTargetRate",
        value: ratio(
          execution.graphManifest?.edges.filter((edge) => edge.target === null).length ?? 0,
          execution.graphManifest?.edges.length ?? 0,
        ),
        direction: "lower",
      });
      const changedKeys = new Set(
        (execution.graphManifest?.changedSymbols ?? []).map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
      );
      const edgeKinds = [...new Set((execution.graphManifest?.edges ?? []).map((edge) => edge.kind))].sort();
      for (const kind of edgeKinds) {
        const byKind = (execution.graphManifest?.edges ?? []).filter((edge) => edge.kind === kind);
        const changedNeighborhood = byKind.filter(
          (edge) => changedKeys.has(edge.source) || Boolean(edge.target && changedKeys.has(edge.target)),
        );
        metrics.push({
          name: `unresolvedTargetRate.${kind}`,
          value: ratio(byKind.filter((edge) => edge.target === null).length, byKind.length),
          direction: "lower",
        });
        metrics.push({
          name: `exactResolutionRate.${kind}`,
          value: ratio(
            byKind.filter((edge) => edge.target !== null && edge.confidence === "exact").length,
            byKind.length,
          ),
          direction: "higher",
        });
        metrics.push({
          name: `changedNeighborhoodExactRate.${kind}`,
          value: ratio(
            changedNeighborhood.filter((edge) => edge.target !== null && edge.confidence === "exact").length,
            changedNeighborhood.length,
          ),
          direction: "higher",
        });
      }
      metrics.push({
        name: "snapshotReady",
        value: execution.graphSnapshot?.state === "READY",
        direction: "exact",
      });
      const graphContract = graphContractMetrics(targets, opts.graphManifest ?? execution.graphManifest);
      metrics.push(...graphContract.metrics);
      diagnostics.push(...graphContract.diagnostics);
      diagnostics.push(
        ...paths
          .filter((item) => !matchedPaths.includes(item))
          .map((item) => `missing path ${item.from}->${item.to} within ${item.maxHops} hop(s)`),
      );
    }
    push({ stage, evaluation: evaluation(stage), metrics, diagnostics });
  }

  const planningLabels = definition.expectations.planning;
  if (!planningLabels) {
    push({ stage: "planning", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
    push({ stage: "ranking", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
    push({ stage: "selection", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
  } else {
    const planningItems = opts.planningWorkItems ?? execution.plannerManifest ?? execution.workItems;
    const planningActual = inspectedItems(planningItems);
    const planningScored = targetMetrics(
      { ...planningLabels, forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [] },
      planningActual,
    );
    const planningMetrics = planningScored.flatMap((item) => [item.metric, item.forbiddenMetric]);
    const planningDiagnostics = planningScored.flatMap((item) => [
      ...item.missing.map((target) => `missing ${target}`),
      ...item.forbidden.map((target) => `forbidden ${target}`),
    ]);
    if (planningLabels.route)
      planningMetrics.push({ name: "routeCorrect", value: execution.route.mode === planningLabels.route, direction: "exact" });
    const unique = new Set(planningItems.map((item) => item.id)).size;
    planningMetrics.push(metric("uniqueWorkItemRate", unique, planningItems.length));
    planningMetrics.push(metric("candidateUnitCoverage", unique, planningItems.length));
    planningMetrics.push(...planningFactorMetrics(planningLabels, planningItems));
    planningMetrics.push({
      name: "candidateBudgetRespected",
      value: (result.coverage.candidateTokensEstimated ?? 0) <= (result.coverage.candidateTokenBudget ?? Infinity),
      direction: "exact",
    });
    const optional = planningLabels.optionalTargets ?? { files: [], symbols: [], edges: [] };
    const optionalScored = targetMetrics(
      { ...optional, forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [] },
      planningActual,
    );
    planningMetrics.push(
      ...optionalScored.map((item) => ({
        ...item.metric,
        name: `optional${item.metric.name[0].toUpperCase()}${item.metric.name.slice(1)}`,
      })),
    );
    push({ stage: "planning", evaluation: evaluation("planning"), metrics: planningMetrics, diagnostics: planningDiagnostics });

    const riskRanking = definition.expectations.ranking ?? planningLabels.riskRanking;
    if (!riskRanking) push({ stage: "ranking", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
    else {
      const score = scorePlanningRiskRanking(
        riskRanking,
        opts.rankingWorkItems ?? opts.planningWorkItems ?? execution.plannerManifest ?? execution.workItems,
      );
      push({
        stage: "ranking",
        evaluation: evaluation("ranking"),
        metrics: [
          { name: "riskRankOrderRecall", value: score.ordered, direction: "higher" },
          { name: "riskMustOutrankAccuracy", value: score.mustOutrank, direction: "higher" },
          { name: "degreeOrderingAccuracy", value: score.degreeOrdering, direction: "higher" },
          { name: "riskExpectedEdgeRecall", value: score.expectedEdges, direction: "higher" },
          { name: "riskPriorityAssertionAccuracy", value: score.priorityAssertions, direction: "higher" },
        ],
        diagnostics: score.diagnostics,
      });
    }

    const selection = definition.expectations.selection ?? planningLabels.selection;
    if (!selection) push({ stage: "selection", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
    else {
      const selected = execution.workItems;
      const selectedKeys = new Set(selected.flatMap(workItemKey));
      const expectedEligible = selection.expectedEligible?.length ? selection.expectedEligible : selection.selected;
      const expectedFeasible = selection.expectedFeasible?.length ? selection.expectedFeasible : selection.selected;
      const matched = expectedEligible.filter((key) => selectedKeys.has(key));
      const constrainedMatched = expectedFeasible.filter((key) => selectedKeys.has(key));
      const usedTokens = selected.reduce((sum, item) => sum + item.estimatedTokens, 0);
      const plannerRows = execution.plannerManifest ?? [];
      const selectedPlannerIds = new Set(selected.map((item) => item.id));
      const budgetLimitedOmissions = plannerRows.filter(
        (item) => !selectedPlannerIds.has(item.id) && item.tokenOmitted,
      ).length;
      const ordinaryOmissions = plannerRows.filter(
        (item) => !selectedPlannerIds.has(item.id) && !item.tokenOmitted,
      ).length;
      const reservedMatched = (selection.requiredReserved ?? []).filter(
        (required) => selectedKeys.has(required) || selected.some((item) => item.kind === required),
      ).length;
      const selectedFiles = new Set(selected.flatMap((item) => item.code.map((snippet) => snippet.file)));
      const forbiddenSelectedFiles = (selection.forbiddenFiles ?? []).filter((file) => selectedFiles.has(file));
      const rankedIds = opts.selectionInput?.rankedWorkItemIds ?? [];
      const selectedIds = selected.map((item) => item.id);
      const rankedPositions = new Map(rankedIds.map((id, index) => [id, index]));
      const rankOrderPreserved = rankedIds.length
        ? selectedIds.every((id, index) => index === 0 || (rankedPositions.get(id) ?? -1) > (rankedPositions.get(selectedIds[index - 1]) ?? -1))
        : null;
      push({
        stage: "selection",
        evaluation: evaluation("selection"),
        metrics: [
          metric("selectionExpectedRecall", matched.length, expectedEligible.length),
          metric("selectionConstrainedRunRecall", constrainedMatched.length, expectedFeasible.length),
          metric("selectionRequiredReservedRecall", reservedMatched, selection.requiredReserved?.length ?? 0),
          { name: "selectionRankOrderPreserved", value: rankOrderPreserved, direction: "exact" },
          { name: "forbiddenSelectionFiles", value: forbiddenSelectedFiles.length, direction: "lower" },
          { name: "budgetLimitedOmissionCount", value: budgetLimitedOmissions, direction: "lower" },
          { name: "ordinaryOmissionCount", value: ordinaryOmissions, direction: "lower" },
          { name: "selectionWorkItemBudgetRespected", value: selected.length <= selection.maxWorkItems, direction: "exact" },
          { name: "selectionTokenBudgetRespected", value: usedTokens <= selection.maxTokens, direction: "exact" },
          metric("selectionRequiredKindRecall", selection.requiredKinds.filter((kind) => selected.some((item) => item.kind === kind)).length, selection.requiredKinds.length),
        ],
        diagnostics: [
          ...expectedEligible.filter((key) => !selectedKeys.has(key)).map((key) => `missing eligible unit ${key}`),
          ...expectedFeasible.filter((key) => !selectedKeys.has(key)).map((key) => `missing feasible unit ${key}`),
          ...forbiddenSelectedFiles.map((file) => `forbidden selected file ${file}`),
          ...(selected.length > selection.maxWorkItems ? [`selection work-item budget exceeded ${selected.length}/${selection.maxWorkItems}`] : []),
          ...(usedTokens > selection.maxTokens ? [`selection token budget exceeded ${usedTokens}/${selection.maxTokens}`] : []),
        ],
      });
    }
  }

  const projection = definition.expectations.projection;
  if (!projection) push({ stage: "projection", evaluation: "not-applicable", metrics: [], diagnostics: ["not in fixture scope"] });
  else {
    // Projection evaluates the repository-wide source projection. Candidate
    // context is scored separately below so a bounded Selection result does
    // not make the source projection appear incomplete.
    const snippets = (execution.sourceProjection ?? execution.projection).code;
    const candidateSnippets = (execution.candidateProjection ?? execution.projection).code;
    const matched = projection.requiredSnippets.filter((expected) =>
      snippets.some(
        (actual) =>
          actual.file === expected.file &&
          (!expected.lineStart || actual.endLine >= expected.lineStart) &&
          (!expected.lineEnd || actual.startLine <= expected.lineEnd) &&
          expected.contains.every((term) => actual.content.toLowerCase().includes(term.toLowerCase())),
      ),
    );
    const forbiddenSnippets = snippets.filter((snippet) => projection.forbiddenFiles.includes(snippet.file));
    const forbiddenFiles = [...new Set(forbiddenSnippets.map((snippet) => snippet.file))];
    const forbiddenContent = projection.forbiddenContent.filter((term) =>
      snippets.some((snippet) => snippet.content.toLowerCase().includes(term.toLowerCase())),
    );
    const duplicateSnippets = snippets.length - new Set(snippets.map((item) => item.id)).size;
    const omittedTokens = execution.projection.audit
      .filter((item) => item.kind === "code" && item.status !== "selected")
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    const totalCodeTokens = execution.projection.audit
      .filter((item) => item.kind === "code")
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    const projectedCodeTokens = snippets.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
    const forbiddenTokens = forbiddenSnippets.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
    const minimumEvidence = (definition.expectations.aggregation?.findings ?? []).flatMap(
      (finding) => finding.minimumEvidence ?? [],
    );
    const candidateContextMissing = minimumEvidence.filter(
      (expected) =>
        !candidateSnippets.some(
          (actual) =>
            actual.file === expected.file &&
            (!expected.lineStart || actual.endLine >= expected.lineStart) &&
            (!expected.lineEnd || actual.startLine <= expected.lineEnd) &&
            expected.contains.every((term) => actual.content.toLowerCase().includes(term.toLowerCase())),
        ),
    );
    push({
      stage: "projection",
      evaluation: evaluation("projection"),
      metrics: [
        metric("requiredSnippetRecall", matched.length, projection.requiredSnippets.length),
        metric("candidateContextRecall", minimumEvidence.length - candidateContextMissing.length, minimumEvidence.length),
        { name: "forbiddenFiles", value: forbiddenFiles.length, direction: "lower" },
        { name: "forbiddenTokenRate", value: ratio(forbiddenTokens, projectedCodeTokens), direction: "lower" },
        { name: "forbiddenContent", value: forbiddenContent.length, direction: "lower" },
        { name: "duplicateSnippets", value: duplicateSnippets, direction: "lower" },
        { name: "omittedCodeTokenRate", value: ratio(omittedTokens, totalCodeTokens), direction: "lower" },
      ],
      diagnostics: [
        ...projection.requiredSnippets
          .filter((item) => !matched.includes(item))
          .map((item) => `missing snippet ${item.file}`),
        ...candidateContextMissing.map((item) => `candidate context missing ${item.file}`),
        ...forbiddenFiles.map((item) => `forbidden projection file ${item}`),
        ...forbiddenContent.map((item) => `forbidden projection content ${item}`),
      ],
    });
  }

  const expectedCandidates = candidateExpectations(definition);
  const candidateStageExecution = opts.candidateExecution ?? execution;
  if (opts.tier === "stage" || !definition.expectations.candidates) {
    push({
      stage: "candidates",
      evaluation: "not-applicable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "not in stage-tier scope" : "not in fixture scope"],
    });
  } else {
    const desired = expectedCandidates.filter((expected) => expected.expectedPresence);
    const forbidden = expectedCandidates.filter((expected) => !expected.expectedPresence);
    const matched = desired.filter((expected) =>
      candidateStageExecution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const generatedForbidden = forbidden.filter((expected) =>
      candidateStageExecution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const anchored = candidateStageExecution.candidates.filter((candidate) =>
      trace.scope.changedFiles.includes(candidate.file),
    ).length;
    const requestsComplete = desired.filter((expected) => {
      const actual = candidateStageExecution.candidates.find((candidate) => candidateMatches(candidate, expected));
      return expected.requiredEvidenceKinds.every((kind) =>
        actual?.evidenceRequests.some((request) => request.kind === kind),
      );
    }).length;
    const reasoningComplete = desired.filter((expected) => {
      const actual = candidateStageExecution.candidates.find((candidate) => candidateMatches(candidate, expected));
      const reasoning = `${actual?.title ?? ""} ${actual?.description ?? ""}`.toLowerCase();
      return (
        expected.requiredReasoningTerms.every((term) => reasoning.includes(term.toLowerCase())) &&
        expected.forbiddenReasoningTerms.every((term) => !reasoning.includes(term.toLowerCase()))
      );
    }).length;
    const nearMiss = collectCandidateNearMissDiagnostics({
      definition,
      scope: trace.scope,
      candidates: candidateStageExecution.candidates,
    });
    push({
      stage: "candidates",
      evaluation: evaluation("candidates"),
      metrics: [
        metric("expectedCandidateRecall", matched.length, desired.length),
        { name: "forbiddenCandidates", value: generatedForbidden.length, direction: "lower" },
        metric("anchorValidity", anchored, candidateStageExecution.candidates.length),
        metric("evidenceRequestCompleteness", requestsComplete, desired.length),
        metric("reasoningTermAccuracy", reasoningComplete, desired.length),
        ...nearMiss.metrics,
      ],
      diagnostics: [],
      diagnosticOnly: [
        ...desired.filter((item) => !matched.includes(item)).map((item) => `missing ${item.id}`),
        ...generatedForbidden.map((item) => `forbidden candidate ${item.id}`),
        ...nearMiss.diagnosticOnly,
      ],
    });
  }

  const evidenceLabels = definition.expectations.evidence?.requests;
  if (opts.tier === "stage" || !evidenceLabels) {
    push({
      stage: "evidence",
      evaluation: "not-applicable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "not in stage-tier scope" : "not in fixture scope"],
    });
  } else {
    let statusMatches = 0;
    let expectedFiles = 0;
    let matchedFiles = 0;
    let forbiddenFiles = 0;
    let expectedSymbols = 0;
    let matchedSymbols = 0;
    let requiredContent = 0;
    let matchedContent = 0;
    let forbiddenContent = 0;
    const diagnostics: string[] = [];
    for (const label of evidenceLabels) {
      const candidateLabel = expectedCandidates.find((item) => item.id === label.candidate);
      const candidate = candidateLabel
        ? execution.candidates.find((item) => candidateMatches(item, candidateLabel))
        : execution.candidates.find((item) => item.id === label.candidate);
      const outcomes = candidate ? (execution.evidenceOutcomes?.[candidate.id] ?? []) : [];
      const outcome = outcomes.find((item) => item.request.kind === label.kind);
      if (outcome?.status === label.status) statusMatches += 1;
      const files = new Set(outcome?.records.map((record) => record.file) ?? []);
      expectedFiles += label.expectedFiles.length;
      matchedFiles += label.expectedFiles.filter((file) => files.has(file)).length;
      forbiddenFiles += label.forbiddenFiles.filter((file) => files.has(file)).length;
      const symbols = new Set(outcome?.records.map((record) => record.symbol).filter(Boolean) ?? []);
      expectedSymbols += label.expectedSymbols.length;
      matchedSymbols += label.expectedSymbols.filter((symbol) =>
        [...symbols].some((actual) => actual === symbol || actual?.endsWith(`.${symbol}`)),
      ).length;
      const snippets = outcome?.records.map((record) => record.snippet.toLowerCase()) ?? [];
      requiredContent += label.requiredContent.length;
      matchedContent += label.requiredContent.filter((term) =>
        snippets.some((snippet) => snippet.includes(term.toLowerCase())),
      ).length;
      forbiddenContent += label.forbiddenContent.filter((term) =>
        snippets.some((snippet) => snippet.includes(term.toLowerCase())),
      ).length;
      if (!outcome) diagnostics.push(`missing ${label.candidate}:${label.kind}`);
    }
    push({
      stage: "evidence",
      evaluation: evaluation("evidence"),
      metrics: [
        metric("resolutionStatusAccuracy", statusMatches, evidenceLabels.length),
        metric("requiredFileRecall", matchedFiles, expectedFiles),
        metric("requiredSymbolRecall", matchedSymbols, expectedSymbols),
        metric("requiredContentRecall", matchedContent, requiredContent),
        { name: "forbiddenRecords", value: forbiddenFiles, direction: "lower" },
        { name: "forbiddenContent", value: forbiddenContent, direction: "lower" },
      ],
      diagnostics,
    });
  }

  const verificationLabels = definition.expectations.verification?.candidates;
  if (opts.tier === "stage" || !verificationLabels) {
    push({
      stage: "verification",
      evaluation: "not-applicable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "not in stage-tier scope" : "not in fixture scope"],
    });
  } else {
    let verdictMatches = 0;
    let falseVerified = 0;
    let cited = 0;
    let groundingDenominator = 0;
    let groundingNumerator = 0;
    let specificityDenominator = 0;
    let specificityNumerator = 0;
    let contractDenominator = 0;
    let contractNumerator = 0;
    let acceptanceDenominator = 0;
    let acceptanceNumerator = 0;
    let reasoningMatches = 0;
    const isBare = (id: string) => id === id.trim() && !id.includes("[") && !id.includes("]");
    const normalizeId = (id: string) => id.trim().replace(/^\[|\]$/g, "");
    const diagnostics: string[] = [];
    const applicable = verificationLabels.filter(
      (expected) =>
        expected.expectedPresence || execution.candidates.some((candidate) => candidateMatches(candidate, expected)),
    );
    const reasoningApplicable = applicable.filter(
      (expected) => expected.requiredReasoningTerms.length || expected.forbiddenReasoningTerms.length,
    );
    for (const expected of applicable) {
      const candidate = execution.candidates.find((item) => candidateMatches(item, expected));
      const verdict = candidate && execution.verification.find((item) => item.candidateId === candidate.id);
      const rawVerdict = verdict?.rawVerdict ?? verdict?.verdict;
      const rawCites = verdict?.rawSupportingEvidenceIds ?? [];
      const cites = rawCites.map(normalizeId);
      const pool = new Set(execution.evidence[candidate?.id ?? ""]?.map((record) => record.id) ?? []);
      if (rawVerdict && rawVerdict === expected.expectedVerdict) verdictMatches += 1;
      if (expected.expectedVerdict !== "verified" && verdict?.verdict === "verified") falseVerified += 1;
      if (expected.expectedVerdict === "verified" && verdict?.supportingEvidenceIds.length) cited += 1;
      const labels: string[] = [];
      if (["verified", "rejected"].includes(expected.expectedVerdict) && rawCites.length) {
        const valid = cites.every((id) => pool.has(id));
        groundingDenominator += 1;
        if (valid) {
          groundingNumerator += 1;
          for (const outcome of execution.evidenceOutcomes?.[candidate?.id ?? ""] ?? []) {
            if (outcome.status !== "satisfied" && outcome.status !== "partial") continue;
            const packed = new Set(outcome.packedRecordIds ?? []);
            specificityDenominator += 1;
            if (cites.some((id) => packed.has(id))) specificityNumerator += 1;
            else labels.push("non_canonical_grounding");
          }
        } else {
          labels.push("hallucinated_grounding");
        }
      }
      if (rawCites.length) {
        contractDenominator += 1;
        if (rawCites.every(isBare)) contractNumerator += 1;
        else labels.push("citation_contract_failure");
      }
      if (rawVerdict && rawVerdict !== expected.expectedVerdict && !labels.length) labels.push("incorrect_verdict");
      if (verdict) {
        acceptanceDenominator += 1;
        const outcomes = execution.evidenceOutcomes?.[candidate?.id ?? ""] ?? [];
        const requiredRequests = outcomes.filter(
          (outcome) => outcome.status === "satisfied" || outcome.status === "partial",
        );
        const canonicalAll =
          expected.expectedVerdict !== "verified" || verdict.supportingEvidenceIds.every((id) => pool.has(id));
        const canonicalCovers =
          expected.expectedVerdict !== "verified" ||
          requiredRequests.every((outcome) =>
            (outcome.packedRecordIds ?? []).some((id) => verdict.supportingEvidenceIds.includes(id)),
          );
        if (verdict.verdict === expected.expectedVerdict && canonicalAll && canonicalCovers) acceptanceNumerator += 1;
      }
      if (labels.length) diagnostics.push(`${labels[0]} ${expected.id}`);
      const reasoning = verdict?.reasoningSummary?.toLowerCase() ?? "";
      if (
        verdict &&
        (expected.requiredReasoningTerms.length > 0 || expected.forbiddenReasoningTerms.length > 0) &&
        expected.requiredReasoningTerms.every((term) => reasoning.includes(term.toLowerCase())) &&
        expected.forbiddenReasoningTerms.every((term) => !reasoning.includes(term.toLowerCase()))
      )
        reasoningMatches += 1;
      if (!verdict) diagnostics.push(`unadjudicated ${expected.id}`);
    }
    push({
      stage: "verification",
      evaluation: evaluation("verification"),
      metrics: [
        metric("verification_accuracy", verdictMatches, applicable.length),
        { name: "falseVerifications", value: falseVerified, direction: "lower" },
        metric("citationRate", cited, applicable.filter((c) => c.expectedVerdict === "verified").length),
        metric("grounding_validity", groundingNumerator, groundingDenominator),
        metric("grounding_specificity", specificityNumerator, specificityDenominator),
        metric("citation_contract_accuracy", contractNumerator, contractDenominator),
        metric("production_acceptance_accuracy", acceptanceNumerator, acceptanceDenominator),
        metric("reasoningTermAccuracy", reasoningMatches, reasoningApplicable.length),
      ],
      diagnostics,
    });
  }

  const aggregation = definition.expectations.aggregation;
  if (opts.tier === "stage" || !aggregation) {
    push({
      stage: "aggregation",
      evaluation: "not-applicable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "not in stage-tier scope" : "not in fixture scope"],
    });
  } else {
    const unmatched = new Set(result.findings.map((_, index) => index));
    let truePositive = 0;
    for (const expected of aggregation.findings) {
      const index = [...unmatched].find((candidate) => findingMatches(result.findings[candidate], expected));
      if (index === undefined) continue;
      unmatched.delete(index);
      truePositive += 1;
    }
    const precision = ratio(truePositive, truePositive + unmatched.size) ?? (aggregation.findings.length ? 0 : 1);
    const recall = ratio(truePositive, aggregation.findings.length) ?? 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    push({
      stage: "aggregation",
      evaluation: evaluation("aggregation"),
      metrics: [
        { name: "precision", value: precision, direction: "higher" },
        { name: "recall", value: recall, direction: "higher" },
        { name: "f1", value: f1, direction: "higher" },
        {
          name: "outcomeCorrect",
          value: aggregation.outcome ? result.outcome === aggregation.outcome : null,
          direction: "exact",
        },
        {
          name: "statusCorrect",
          value: aggregation.status ? result.status === aggregation.status : null,
          direction: "exact",
        },
      ],
      diagnostics: [],
    });
  }

  const reporting = definition.expectations.reporting;
  if (opts.tier === "stage" || !reporting)
    push({
      stage: "reporting",
      evaluation: "not-applicable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "not in stage-tier scope" : "not in fixture scope"],
    });
  else {
    const rendered = opts.reportMarkdown ?? "";
    const matched = reporting.requiredSections.filter((section) => rendered.includes(section));
    const coverageConsistent =
      result.coverage.changedFilesReviewed <= result.coverage.changedFiles &&
      result.coverage.changedSymbolsReviewed <= result.coverage.changedSymbols;
    const provenanceComplete = Boolean(
      execution.graphSnapshot?.schemaVersion &&
      Object.keys(execution.graphSnapshot.providerVersions).length &&
      execution.modelProfiles.candidate &&
      execution.modelProfiles.verifier,
    );
    push({
      stage: "reporting",
      evaluation: evaluation("reporting"),
      metrics: [
        metric("requiredContent", matched.length, reporting.requiredSections.length),
        { name: "coverageConsistent", value: coverageConsistent, direction: "exact" },
        { name: "provenanceComplete", value: provenanceComplete, direction: "exact" },
      ],
      diagnostics: reporting.requiredSections
        .filter((item) => !matched.includes(item))
        .map((item) => `missing ${item}`),
    });
  }
  const timingKey: Record<EvalStage, keyof NonNullable<EngineExecution["stageTimingsMs"]>> = {
    snapshot: "snapshot",
    graph: "graph",
    projection: "projection",
    planning: "planning",
    ranking: "ranking",
    selection: "selection",
    candidates: "candidateGeneration",
    evidence: "evidence",
    verification: "verification",
    aggregation: "aggregation",
    reporting: "reporting",
  };
  for (const stage of values) {
    if (!["executed", "observed"].includes(stage.evaluation)) continue;
    const stageExecution = stage.stage === "candidates" ? candidateStageExecution : execution;
    const wallMs = stageExecution.stageTimingsMs?.[timingKey[stage.stage]];
    stage.metrics.push({ name: "wallMs", value: wallMs ?? null, direction: "lower" });
    if (stage.stage === "candidates")
      stage.metrics.push({
        name: "providerMs",
        value: candidateStageExecution.coverage?.candidateProviderMs ?? null,
        direction: "lower",
      });
    if (stage.stage === "verification")
      stage.metrics.push({
        name: "providerMs",
        value: result.coverage.verificationProviderMs ?? null,
        direction: "lower",
      });
  }

  const expectedPositive = expectedCandidates.filter((candidate) => candidate.expectedPresence);
  const candidateMatched = expectedPositive.filter((expected) =>
    candidateStageExecution.candidates.some((candidate) => candidateMatches(candidate, expected)),
  );
  const candidateFailure =
    opts.tier !== "stage" && expectedPositive.length > 0 && candidateMatched.length < expectedPositive.length;
  const isolateDownstream = opts.tier === "isolated";
  const labeledEvidenceLabels = definition.expectations.evidence?.requests ?? [];
  const evidenceFailure = labeledEvidenceLabels.some((label) => {
    const expected = expectedCandidates.find((candidate) => candidate.id === label.candidate);
    const actual = expected && execution.candidates.find((candidate) => candidateMatches(candidate, expected));
    if (!actual) return false;
    const outcome = actual && execution.evidenceOutcomes?.[actual.id]?.find((item) => item.request.kind === label.kind);
    return !outcome || outcome.status !== label.status;
  });
  const labeledVerificationLabels = definition.expectations.verification?.candidates ?? [];
  const verificationFailure = labeledVerificationLabels.some((expected) => {
    const actual = execution.candidates.find((candidate) => candidateMatches(candidate, expected));
    const verdict = actual && execution.verification.find((item) => item.candidateId === actual.id);
    return Boolean(actual && (!verdict || verdict.verdict !== expected.expectedVerdict));
  });
  const aggregationStage = values.find((stage) => stage.stage === "aggregation");
  const aggregationFailure = Boolean(
    aggregationStage?.metrics.some(
      (item) =>
        (["precision", "recall"].includes(item.name) && item.value !== 1) ||
        (["outcomeCorrect", "statusCorrect"].includes(item.name) && item.value !== null && item.value !== true),
    ),
  );
  const candidateStage = values.find((stage) => stage.stage === "candidates");
  const candidateCausalFailure = Boolean(
    candidateStage?.diagnostics.some((diagnostic) => !candidateStage.diagnosticOnly?.includes(diagnostic)) ||
      (opts.tier === "isolated" && candidateStageExecution !== execution && candidateFailure),
  );
  for (const stage of values) {
    if (["not-applicable", "not-evaluable", "incompatible"].includes(stage.evaluation)) continue;
    if (stage.stage === "candidates") {
      stage.causalStatus = candidateCausalFailure ? "root-failure" : "healthy";
    } else if (stage.stage === "evidence") {
      stage.causalStatus =
        !isolateDownstream && candidateCausalFailure ? "downstream-blocked" : evidenceFailure ? "root-failure" : "healthy";
      if (!isolateDownstream && candidateCausalFailure) stage.blockedBy = ["candidates"];
      } else if (stage.stage === "verification") {
      stage.causalStatus =
        (!isolateDownstream && candidateCausalFailure) || evidenceFailure
          ? "downstream-blocked"
          : verificationFailure
            ? "root-failure"
            : "healthy";
      if (!isolateDownstream && candidateCausalFailure) stage.blockedBy = ["candidates"];
      else if (evidenceFailure) stage.blockedBy = ["evidence"];
    } else if (stage.stage === "aggregation") {
      stage.causalStatus =
        (!isolateDownstream && candidateCausalFailure) || evidenceFailure || verificationFailure
          ? "downstream-blocked"
          : aggregationFailure
            ? "root-failure"
            : "healthy";
      if (!isolateDownstream && candidateCausalFailure) stage.blockedBy = ["candidates"];
      else if (evidenceFailure) stage.blockedBy = ["evidence"];
      else if (verificationFailure) stage.blockedBy = ["verification"];
    } else if (stage.stage === "reporting") {
      stage.causalStatus = aggregationFailure ? "downstream-blocked" : "healthy";
      if (aggregationFailure) stage.blockedBy = ["aggregation"];
    } else {
      const causalDiagnostics = stage.diagnostics.filter(
        (diagnostic) => !stage.diagnosticOnly?.includes(diagnostic),
      );
      stage.causalStatus = causalDiagnostics.length ? "root-failure" : "healthy";
    }
  }
  return values;
}

function display(value: number | boolean | null): string {
  if (value === null) return "N/A";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function formatStageScorecard(stages: StageEvaluation[]): string[] {
  return [
    "| Stage | Evaluation | Causal status | Metrics | Diagnostics |",
    "|---|---|---|---|---|",
    ...stages.map(
      (stage) =>
        `| ${stage.stage} | ${stage.evaluation} | ${stage.causalStatus ?? "N/A"}${stage.blockedBy?.length ? ` (${stage.blockedBy.join(", ")})` : ""} | ${stage.metrics.map((item) => `${item.name}=${display(item.value)}`).join(", ") || "N/A"} | ${stage.diagnostics.join("; ") || "—"}${stage.diagnosticOnly?.length ? ` Diagnostic-only: ${stage.diagnosticOnly.join("; ")}` : ""} |`,
    ),
  ];
}
