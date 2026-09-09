import path from "node:path";
import { sha256Json } from "../core/hash.js";
import type { ModelProfile, PartitionedReviewPolicy, ReviewRoutingPolicy } from "../core/types.js";
import type { GraphContext, GraphContextEdge, GraphContextNode, GraphSymbol } from "../core/graph/types.js";
import type { ReviewScope } from "./scope.js";
import type {
  ProjectionBudget,
  ProjectedSnippet,
  ReviewProjection,
  ReviewWorkItem,
  RouteDecision,
  ScoutFinding,
  StructuredReviewRule,
} from "./engine-types.js";
import { selectRules } from "./rules.js";
import { parseChangedRanges } from "../core/diff.js";

function sha(value: unknown) {
  return sha256Json(value, 20);
}

export function projectionBudget(profile: ModelProfile, routing: ReviewRoutingPolicy): ProjectionBudget {
  return {
    contextTokens: profile.contextTokens,
    inputBudgetTokens: Math.max(
      1,
      Math.min(
        Math.floor(profile.contextTokens * routing.inputContextFraction),
        profile.contextTokens - profile.requestedOutputTokens - profile.safetyReserveTokens,
      ),
    ),
    requestedOutputTokens: profile.requestedOutputTokens,
    safetyReserveTokens: profile.safetyReserveTokens,
  };
}

export function estimateTokens(value: string, profile: ModelProfile, code = true): number {
  const ratio = code ? profile.tokenizer.codeCharsPerToken : profile.tokenizer.proseCharsPerToken;
  return Math.ceil(value.length / ratio);
}

export const MAX_DEGREE_BOOST = 20;
export const DEGREE_CAP = 16;

export interface CanonicalGraphFactors {
  fanIn: number;
  fanOut: number;
  neighborDegree: number;
  directedIncidentDegree: number;
}

function canonicalGraphFactors(edges: GraphContextEdge[], nodeKey: string): CanonicalGraphFactors {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!edge.target || edge.source === edge.target) continue;
    const key = `${edge.kind}:${edge.source}:${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (edge.target === nodeKey) incoming.add(edge.source);
    if (edge.source === nodeKey) outgoing.add(edge.target);
  }
  return {
    fanIn: incoming.size,
    fanOut: outgoing.size,
    neighborDegree: new Set([...incoming, ...outgoing]).size,
    directedIncidentDegree: incoming.size + outgoing.size,
  };
}

export function graphDegreeContribution(neighborDegree: number): number {
  if (neighborDegree <= 0) return 0;
  return MAX_DEGREE_BOOST * Math.min(Math.log1p(neighborDegree) / Math.log1p(DEGREE_CAP), 1);
}

export function riskScore(item: Pick<ReviewWorkItem, "priority" | "rankFactors">, includeDegree = true): number {
  const semanticRisk = item.rankFactors?.semanticRisk ?? item.priority ?? 0;
  const degree = item.rankFactors?.neighborDegree ?? item.rankFactors?.graphDegree ?? 0;
  return semanticRisk + (includeDegree ? graphDegreeContribution(degree) : 0);
}

export const changedRanges = parseChangedRanges;

function snippet(
  file: string,
  content: string,
  startLine: number,
  endLine: number,
  profile: ModelProfile,
  options: { symbol?: string; changed: boolean; score: number; reason: string },
): ProjectedSnippet {
  const lines = content.split("\n");
  const selected = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
  return {
    id: sha({ file, startLine, endLine, symbol: options.symbol, selected }),
    file,
    startLine,
    endLine,
    symbol: options.symbol,
    content: selected,
    changed: options.changed,
    score: options.score,
    reason: options.reason,
    estimatedTokens: estimateTokens(selected, profile),
  };
}

function symbolSnippet(
  scope: ReviewScope,
  symbol: GraphSymbol,
  profile: ModelProfile,
  changed: boolean,
  score: number,
) {
  const content = scope.fileContents[symbol.file];
  if (content !== undefined) {
    const projected = snippet(symbol.file, content, symbol.startLine, symbol.endLine, profile, {
      symbol: symbol.qualifiedName,
      changed,
      score,
      reason: changed ? "changed symbol overlaps patch" : "repository graph neighbor",
    });
    projected.changedLineRanges = changedRanges(scope.diff)
      .filter((range) => range.file === symbol.file && range.start <= symbol.endLine && range.end >= symbol.startLine)
      .map((range) => ({ start: Math.max(range.start, symbol.startLine), end: Math.min(range.end, symbol.endLine) }));
    return projected;
  }
  return undefined;
}

function dependencySummary(scope: ReviewScope): string[] {
  const packageEntry = scope.manifest?.find((entry) => entry.path === "package.json");
  const packageContent = scope.fileContents["package.json"];
  if (!packageEntry || !packageContent) return [];
  try {
    const parsed = JSON.parse(packageContent) as Record<string, unknown>;
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const values = sections.flatMap((section) => {
      const dependencies = parsed[section];
      if (!dependencies || typeof dependencies !== "object") return [];
      return Object.entries(dependencies as Record<string, unknown>).map(
        ([name, version]) => `${section}: ${name}=${String(version)}`,
      );
    });
    const lockfiles = (scope.manifest ?? [])
      .filter((entry) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(entry.path))
      .map((entry) => `lockfile changed: ${entry.path}; raw lockfile content omitted from code context`);
    return [...values.slice(0, 80), ...lockfiles];
  } catch {
    return ["package.json changed; dependency manifest could not be parsed"];
  }
}

function suppliedContextSummary(scope: ReviewScope): string[] {
  return Object.entries(scope.suppliedContext)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, content]) => `supplied context ${file}:\n${content.slice(0, 8_000)}`);
}

function fallbackSnippets(
  scope: ReviewScope,
  profile: ModelProfile,
  semanticSnippets: ProjectedSnippet[],
): ProjectedSnippet[] {
  const ranges = changedRanges(scope.diff);
  const snippets: ProjectedSnippet[] = [];
  for (const entry of scope.manifest ?? []) {
    if (
      entry.binary ||
      entry.generated ||
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(entry.path) ||
      (entry.sizeBytes ?? 0) > 300_000
    )
      continue;
    const content = scope.fileContents[entry.path] ?? "";
    const fileRanges = ranges.filter((range) => range.file === entry.path);
    const semanticForFile = semanticSnippets.filter((item) => item.file === entry.path && item.changed);
    if (!fileRanges.length && content && !semanticForFile.length)
      snippets.push(
        snippet(entry.path, content, 1, content.split("\n").length, profile, {
          changed: true,
          score: 120,
          reason: "changed file without semantic symbol boundary",
        }),
      );
    for (const range of fileRanges) {
      if (semanticForFile.some((item) => item.startLine <= range.start && item.endLine >= range.end)) continue;
      snippets.push(
        snippet(entry.path, content, Math.max(1, range.start - 12), range.end + 12, profile, {
          changed: true,
          score: 120,
          reason: "changed hunk fallback with surrounding context",
        }),
      );
    }
  }
  return snippets;
}

function compactSnippet(value: ProjectedSnippet, profile: ModelProfile): ProjectedSnippet {
  const signature = value.content.split("\n").find((line) => line.trim()) ?? "";
  return {
    ...value,
    content: signature,
    endLine: value.startLine,
    estimatedTokens: estimateTokens(signature, profile),
  };
}

export function buildProjection(opts: {
  scope: ReviewScope;
  graph: GraphContext;
  profile: ModelProfile;
  rules: StructuredReviewRule[];
  kind: "full" | "compact";
  deterministicReport?: string;
}): ReviewProjection {
  const changedKeys = new Set(opts.graph.changedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`));
  const code = opts.graph.nodes
    .map((node) => {
      const changed = changedKeys.has(`${node.symbol.file}:${node.symbol.qualifiedName}`);
      const captured = symbolSnippet(opts.scope, node.symbol, opts.profile, changed, node.score);
      if (captured || !node.excerpt) return captured;
      return {
        id: sha({ file: node.symbol.file, symbol: node.symbol.qualifiedName, excerpt: node.excerpt }),
        file: node.symbol.file,
        startLine: node.symbol.startLine,
        endLine: node.symbol.startLine + node.excerpt.split("\n").length - 1,
        symbol: node.symbol.qualifiedName,
        content: node.excerpt,
        changed: false,
        score: node.score,
        reason: "repository graph neighbor",
        estimatedTokens: estimateTokens(node.excerpt, opts.profile),
      } satisfies ProjectedSnippet;
    })
    .filter((value): value is ProjectedSnippet => Boolean(value));
  code.push(...fallbackSnippets(opts.scope, opts.profile, code));
  const unique = [...new Map(code.map((item) => [item.id, item])).values()].sort(
    (left, right) =>
      right.score - left.score || left.file.localeCompare(right.file) || left.startLine - right.startLine,
  );
  const projectedCode = opts.kind === "compact" ? unique.map((item) => compactSnippet(item, opts.profile)) : unique;
  const summarizedDependencies = dependencySummary(opts.scope);
  const summarizedContext = suppliedContextSummary(opts.scope);
  const graphSummary = opts.graph.edges
    .map((edge) => `${edge.kind}: ${edge.source} -> ${edge.target ?? edge.targetText} (${edge.confidence})`)
    .join("\n");
  const base: ReviewProjection = {
    id: "",
    kind: opts.kind,
    estimatedTokens: 0,
    manifest: opts.scope.manifest ?? [],
    rules: [],
    code: projectedCode,
    graphEdges: opts.graph.edges,
    graphSummary,
    deterministicReport: opts.deterministicReport,
    dependencySummary: summarizedDependencies,
    contextSummary: summarizedContext,
    metadata: { base: opts.scope.base, snapshotId: opts.scope.id, languages: opts.scope.languages ?? [] },
    audit: [],
    omissions: [
      ...(opts.scope.omissions ?? []),
      ...(opts.scope.manifest ?? [])
        .filter((entry) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(entry.path))
        .map((entry) => ({
          kind: "file" as const,
          id: entry.path,
          reason: "unsupported-artifact" as const,
          details: "lockfile retained in the manifest and dependency summary but excluded from raw code context",
        })),
      ...(opts.scope.manifest ?? [])
        .filter(
          (entry) =>
            !entry.generated &&
            (entry.sizeBytes ?? 0) > 300_000 &&
            !opts.graph.changedSymbols.some((symbol) => symbol.file === entry.path),
        )
        .map((entry) => ({
          kind: "file" as const,
          id: entry.path,
          reason: "unsafe-large-file" as const,
          details: "file exceeds 300000 bytes and has no safe semantic projection",
        })),
    ],
  };
  base.rules = selectRules(opts.rules, base, Number.POSITIVE_INFINITY);
  const manifestText = JSON.stringify(base.manifest);
  const fixed =
    estimateTokens(manifestText, opts.profile, false) +
    estimateTokens(graphSummary, opts.profile, false) +
    estimateTokens(opts.deterministicReport ?? "", opts.profile, false) +
    summarizedDependencies.reduce((sum, summary) => sum + estimateTokens(summary, opts.profile, false), 0) +
    summarizedContext.reduce((sum, summary) => sum + estimateTokens(summary, opts.profile, false), 0) +
    700;
  base.estimatedTokens =
    fixed +
    base.code.reduce((sum, item) => sum + item.estimatedTokens, 0) +
    base.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
  base.audit = [
    { kind: "instructions", id: "review-contract-v2", estimatedTokens: 700, score: 1000, status: "selected" },
    {
      kind: "manifest",
      id: "change-manifest",
      estimatedTokens: estimateTokens(manifestText, opts.profile, false),
      score: 900,
      status: "selected",
    },
    ...(opts.deterministicReport
      ? [
          {
            kind: "report" as const,
            id: "deterministic-gate-report",
            estimatedTokens: estimateTokens(opts.deterministicReport, opts.profile, false),
            score: 850,
            status: "selected" as const,
          },
        ]
      : []),
    ...summarizedDependencies.map((summary) => ({
      kind: "dependency-summary" as const,
      id: sha({ kind: "dependency-summary", summary }),
      estimatedTokens: estimateTokens(summary, opts.profile, false),
      score: 700,
      status: "selected" as const,
    })),
    ...summarizedContext.map((summary) => ({
      kind: "context-summary" as const,
      id: sha({ kind: "context-summary", summary }),
      estimatedTokens: estimateTokens(summary, opts.profile, false),
      score: 800,
      status: "selected" as const,
    })),
    ...base.rules.map((rule) => ({
      kind: "rules" as const,
      id: rule.id,
      estimatedTokens: rule.estimatedTokens,
      score: 500,
      status: "selected" as const,
    })),
    ...base.code.map((item) => ({
      kind: "code" as const,
      id: item.id,
      estimatedTokens: item.estimatedTokens,
      score: item.score,
      status: "selected" as const,
    })),
  ];
  base.id = sha({
    kind: base.kind,
    metadata: base.metadata,
    rules: base.rules,
    code: base.code.map((item) => item.id),
    graphSummary,
    deterministicReport: opts.deterministicReport,
    dependencySummary: summarizedDependencies,
    contextSummary: summarizedContext,
  });
  return base;
}

export function routeReview(opts: {
  requestedMode: "auto" | "holistic" | "partitioned" | "hybrid";
  candidate: ModelProfile;
  scout?: ModelProfile;
  routing: ReviewRoutingPolicy;
  full: ReviewProjection;
  compact: ReviewProjection;
}): RouteDecision {
  const candidateBudget = projectionBudget(opts.candidate, opts.routing);
  const partitionedFits = candidateBudget.inputBudgetTokens > 1200;
  const scoutBudget = opts.scout ? projectionBudget(opts.scout, opts.routing) : undefined;
  const holisticFits =
    opts.candidate.reviewCapability === "strong" && opts.full.estimatedTokens <= candidateBudget.inputBudgetTokens;
  const hybridFits = Boolean(
    opts.scout && scoutBudget && opts.compact.estimatedTokens <= scoutBudget.inputBudgetTokens,
  );
  const valid = (mode: "holistic" | "partitioned" | "hybrid") => {
    if (mode === "holistic") return opts.routing.enableHolistic && holisticFits;
    if (mode === "hybrid") return opts.routing.enableHybrid && hybridFits;
    return opts.routing.enablePartitioned && partitionedFits;
  };
  if (opts.requestedMode !== "auto") {
    if (!valid(opts.requestedMode))
      throw new Error(`Forced review mode cannot run with the selected model profiles: ${opts.requestedMode}`);
    return {
      mode: opts.requestedMode,
      reason: "explicit project routing override",
      fullProjectionTokens: opts.full.estimatedTokens,
      compactProjectionTokens: opts.compact.estimatedTokens,
      candidateBudget,
      scoutBudget,
    };
  }
  const mode =
    holisticFits && opts.routing.enableHolistic
      ? "holistic"
      : hybridFits && opts.routing.enableHybrid
        ? "hybrid"
        : "partitioned";
  if (!valid(mode)) throw new Error("No enabled review mode can run with the selected model profiles");
  return {
    mode,
    reason:
      mode === "holistic"
        ? "complete projection fits strong candidate model"
        : mode === "hybrid"
          ? "complete projection does not fit; compact projection fits strong scout"
          : "bounded work items required",
    fullProjectionTokens: opts.full.estimatedTokens,
    compactProjectionTokens: opts.compact.estimatedTokens,
    candidateBudget,
    scoutBudget,
  };
}

function boundedSnippet(
  item: ProjectedSnippet,
  budget: number,
  profile: ModelProfile,
  focus?: { start: number; end: number },
): ProjectedSnippet {
  if (item.estimatedTokens <= budget) return item;
  const lines = item.content.split("\n");
  const maxChars = Math.max(200, Math.floor(budget * profile.tokenizer.codeCharsPerToken));
  const range = focus ?? item.changedLineRanges?.[0];
  const localStart = range ? Math.max(0, range.start - item.startLine - 12) : 0;
  let localEnd = range ? Math.min(lines.length, range.end - item.startLine + 13) : lines.length;
  let content = lines.slice(localStart, localEnd).join("\n");
  while (content.length > maxChars && localEnd > localStart + 1) {
    localEnd--;
    content = lines.slice(localStart, localEnd).join("\n");
  }
  if (content.length > maxChars) content = content.slice(0, maxChars);
  const startLine = item.startLine + localStart;
  return {
    ...item,
    content,
    startLine,
    endLine: startLine + content.split("\n").length - 1,
    estimatedTokens: estimateTokens(content, profile),
    reason: `${item.reason}; hunk-centered bounded semantic slice`,
  };
}

function boundedMultiRegionSnippets(
  item: ProjectedSnippet,
  budget: number,
  profile: ModelProfile,
  ranges: Array<{ start: number; end: number }> = item.changedLineRanges ?? [],
): ProjectedSnippet[] {
  if (item.estimatedTokens <= budget || !ranges.length) return [boundedSnippet(item, budget, profile, ranges[0])];
  const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const perRegionBudget = Math.max(32, Math.floor(budget / ordered.length));
  const snippets = ordered.map((range) => boundedSnippet(item, perRegionBudget, profile, range));
  return [
    ...new Map(
      snippets.map((snippet) => [
        `${snippet.file}:${snippet.startLine}:${snippet.endLine}:${snippet.content}`,
        snippet,
      ]),
    ).values(),
  ];
}

export function buildCandidateProjection(
  source: ReviewProjection,
  selected: ReviewWorkItem[],
  profile: ModelProfile,
): ReviewProjection {
  if (!selected.length) return { ...source, kind: "work-item" };
  const code = [
    ...new Map(
      selected
        .flatMap((item) => item.code)
        .map((snippet) => [`${snippet.file}:${snippet.startLine}:${snippet.endLine}:${snippet.content}`, snippet]),
    ).values(),
  ];
  const files = new Set(code.map((snippet) => snippet.file));
  const rules = [...new Map(selected.flatMap((item) => item.rules).map((rule) => [rule.id, rule])).values()];
  const graphEdges = [
    ...new Map(
      selected
        .flatMap((item) => item.graphEdges)
        .map((edge) => [`${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`, edge]),
    ).values(),
  ];
  const dependencySummary = [...new Set(selected.flatMap((item) => item.contextSummaries ?? []))];
  const estimatedTokens =
    code.reduce((sum, snippet) => sum + snippet.estimatedTokens, 0) +
    rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0) +
    estimateTokens(dependencySummary.join("\n"), profile, false);
  return {
    ...source,
    id: sha({ source: source.id, selected: selected.map((item) => item.id), code: code.map((item) => item.id) }),
    kind: "work-item",
    estimatedTokens,
    manifest: source.manifest.filter((entry) => files.has(entry.path)),
    rules,
    code,
    graphEdges,
    dependencySummary,
    audit: code.map((snippet) => ({
      kind: "code",
      id: snippet.id,
      estimatedTokens: snippet.estimatedTokens,
      score: snippet.score,
      status: "selected",
      reason: snippet.reason,
    })),
    omissions: [],
  };
}

function symbolKey(symbol: GraphSymbol) {
  return `${symbol.file}:${symbol.qualifiedName}`;
}
function interactionPriority(edge: GraphContextEdge, changed: Set<string>, hot: Set<string>) {
  const sourceFile = edge.source.split(":", 1)[0];
  const targetFile = edge.target?.split(":", 1)[0];
  // Cross-file contract edges are the most useful traversal checks: they
  // exercise whether the planner can follow a changed symbol into its API
  // surface instead of spending the budget on same-file neighbors.
  const crossFileContractBonus =
    targetFile && sourceFile !== targetFile && (edge.kind === "reads-type" || edge.kind === "implements") ? 80 : 0;
  const base =
    edge.kind === "implements" || edge.kind === "extends"
      ? 100
      : ["schema-user", "serialization", "producer-consumer", "config"].includes(edge.kind)
        ? 90
        : edge.kind === "calls"
          ? 80
          : edge.kind === "reads-type"
            ? 120
            : edge.kind === "references"
              ? 100
              : edge.kind === "test-reference"
                ? 40
                : edge.kind === "imports"
                  ? 10
                  : 20;
  return (
    base +
    crossFileContractBonus +
    (edge.target && changed.has(edge.source) && changed.has(edge.target) ? 30 : 0) +
    (edge.confidence === "exact" ? 10 : 0) +
    (hot.has(edge.source) || (edge.target ? hot.has(edge.target) : false) ? 50 : 0)
  );
}

function interactionFamily(kind: string): string {
  if (["schema-user", "serialization", "producer-consumer", "config"].includes(kind)) return "contract";
  if (["reads-type", "implements", "extends"].includes(kind)) return "type";
  if (["calls", "references", "test-reference"].includes(kind)) return "flow";
  return kind;
}

function filePriority(file: string) {
  if (/^(src|bin|scripts|plugins|integrations|hooks|packs|policy)\//.test(file)) return 100;
  if (/^(package\.json|package-lock\.json|quality\.ya?ml|tsconfig\.json|eslint\.config\.)/.test(file)) return 95;
  if (/(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[^.]+$/.test(file)) return 60;
  if (/\.(ts|tsx|js|jsx|py|pyi|go|rs)$/.test(file)) return 90;
  if (/\.(ya?ml|json|toml|ini|cfg|mjs|cjs)$/.test(file)) return 70;
  return 20;
}

function symbolPriority(symbol: GraphSymbol, nodes: GraphContextNode[]) {
  return nodes.find((node) => symbolKey(node.symbol) === symbolKey(symbol))?.score ?? 0;
}

function workItemRank(left: ReviewWorkItem, right: ReviewWorkItem) {
  const leftFactors = left.rankFactors;
  const rightFactors = right.rankFactors;
  return (
    (right.priority ?? 0) - (left.priority ?? 0) ||
    (rightFactors?.productionSurface ?? 0) - (leftFactors?.productionSurface ?? 0) ||
    (rightFactors?.changedEndpoints ?? 0) - (leftFactors?.changedEndpoints ?? 0) ||
    (rightFactors?.edgeRisk ?? 0) - (leftFactors?.edgeRisk ?? 0) ||
    (rightFactors?.changedLines ?? 0) - (leftFactors?.changedLines ?? 0) ||
    left.kind.localeCompare(right.kind) ||
    workItemSemanticKey(left).localeCompare(workItemSemanticKey(right))
  );
}

function workItemSemanticKey(item: ReviewWorkItem): string {
  return [
    item.kind,
    ...item.primarySymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
    ...item.relatedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
    ...item.graphEdges.map((edge) => edge.kind),
  ].join("|");
}

function uniqueWorkItems(items: ReviewWorkItem[]): ReviewWorkItem[] {
  const values = new Map<string, ReviewWorkItem>();
  for (const item of items) if (!values.has(item.id)) values.set(item.id, item);
  return [...values.values()];
}

export function rankWorkItems(items: ReviewWorkItem[], options: { includeDegree?: boolean } = {}): ReviewWorkItem[] {
  const includeDegree = options.includeDegree !== false;
  const scored: ReviewWorkItem[] = uniqueWorkItems(items).map((item) => ({
    ...item,
    priority: riskScore(item, includeDegree),
    rankFactors: item.rankFactors
      ? {
          ...item.rankFactors,
          semanticRisk: item.rankFactors.semanticRisk ?? item.priority ?? 0,
          graphDegree: item.rankFactors.graphDegree ?? item.rankFactors.neighborDegree ?? 0,
          degreeContribution: includeDegree
            ? graphDegreeContribution(item.rankFactors.neighborDegree ?? item.rankFactors.graphDegree ?? 0)
            : 0,
        }
      : undefined,
  }));
  return scored.sort(workItemRank).map((item, index) => ({ ...item, rank: index + 1 }));
}

export function selectWorkItems(items: ReviewWorkItem[], limit: number, tokenBudget = Number.POSITIVE_INFINITY) {
  // Selection is a consumer of Ranking's ordered sequence. Callers that need
  // ranking must do it explicitly before crossing this boundary.
  const ranked = uniqueWorkItems(items).map((item) => ({
    ...item,
    rankFactors: item.rankFactors ? { ...item.rankFactors } : undefined,
  }));
  const incomingRank = new Map(ranked.map((item, index) => [item.id, item.rank ?? index + 1]));
  const compareIncomingRank = (left: ReviewWorkItem, right: ReviewWorkItem) =>
    (incomingRank.get(left.id) ?? Number.POSITIVE_INFINITY) - (incomingRank.get(right.id) ?? Number.POSITIVE_INFINITY);
  const selected: ReviewWorkItem[] = [];
  const omitted: ReviewWorkItem[] = [];
  const tokenOmitted: ReviewWorkItem[] = [];
  let usedTokens = 0;
  if (limit >= 2) {
    const locals = ranked.filter((item) => item.kind === "local");
    const interactions = ranked.filter((item) => item.kind === "interaction");
    let pair: [ReviewWorkItem, ReviewWorkItem] | undefined;
    for (const local of locals) {
      for (const interaction of interactions) {
        if (local.estimatedTokens + interaction.estimatedTokens <= tokenBudget) {
          pair = [local, interaction];
          break;
        }
      }
      if (pair) break;
    }
    if (pair) {
      selected.push(...pair.sort(compareIncomingRank));
      for (const item of selected)
        item.selectionReason = `required-${item.kind}; priority=${item.priority ?? 0}; semantic=${workItemSemanticKey(item)}`;
      usedTokens = pair.reduce((sum, item) => sum + item.estimatedTokens, 0);
    }
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  while (selected.length < Math.max(0, limit)) {
    const remaining = ranked.filter((item) => !selectedIds.has(item.id));
    const fitting = remaining.filter((item) => usedTokens + item.estimatedTokens <= tokenBudget);
    if (!fitting.length) break;
    const item = fitting[0];
    item.selectionReason = `ranked-fill; rank=${item.rank ?? incomingRank.get(item.id) ?? "unknown"}; semantic=${workItemSemanticKey(item)}`;
    selected.push(item);
    selectedIds.add(item.id);
    usedTokens += item.estimatedTokens;
  }
  const budgetLimited = selected.length < Math.max(0, limit);
  for (const item of ranked.filter((entry) => !selectedIds.has(entry.id))) {
    omitted.push(item);
    if (budgetLimited && usedTokens + item.estimatedTokens > tokenBudget) {
      tokenOmitted.push(item);
      item.selectionReason = `omitted-token-budget; rank=${item.rank ?? incomingRank.get(item.id) ?? "unknown"}`;
    } else {
      item.selectionReason = `omitted-lower-ranked; rank=${item.rank ?? incomingRank.get(item.id) ?? "unknown"}`;
    }
  }
  return { selected, omitted, tokenOmitted, estimatedTokens: usedTokens };
}

export function buildWorkItems(opts: {
  projection: ReviewProjection;
  graph: GraphContext;
  profile: ModelProfile;
  policy: PartitionedReviewPolicy;
  rules: StructuredReviewRule[];
  inputBudgetTokens: number;
  maxInteractionNeighborsPerSymbol?: number;
  hotspots?: ScoutFinding[];
}): ReviewWorkItem[] {
  const changedSymbols = [...new Map(opts.graph.changedSymbols.map((symbol) => [symbolKey(symbol), symbol])).values()];
  const graphEdges = [
    ...new Map(
      opts.graph.edges.map((edge) => [`${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`, edge]),
    ).values(),
  ];
  const factorsFor = (nodeKey: string) => canonicalGraphFactors(graphEdges, nodeKey);
  const bySymbol = new Map<string, ProjectedSnippet[]>();
  for (const code of opts.projection.code.filter((entry) => entry.symbol)) {
    const key = `${code.file}:${code.symbol}`;
    const values = bySymbol.get(key) ?? [];
    values.push(code);
    bySymbol.set(key, values);
  }
  const deterministicReport = opts.projection.deterministicReport?.slice(0, 2000);
  const overhead = 900 + estimateTokens(deterministicReport ?? "", opts.profile, false);
  const ruleTokenReserve = [...opts.rules]
    .map((rule) => Math.ceil(rule.short.length / 3))
    .sort((left, right) => right - left)
    .slice(0, opts.policy.maxRulesPerUnit)
    .reduce((sum, value) => sum + value, 0);
  const hotspotSymbols = new Set(
    (opts.hotspots ?? []).flatMap((hotspot) => [...hotspot.symbols, ...hotspot.requestedInspection.symbols]),
  );
  const hotspotEdgeKinds = new Set(
    (opts.hotspots ?? []).flatMap((hotspot) => hotspot.requestedInspection.edgeKinds ?? []),
  );
  const hasScoutTargets = Boolean(opts.hotspots?.length && (hotspotSymbols.size || hotspotEdgeKinds.size));
  const locals: ReviewWorkItem[] = [];
  const addLocal = (item: ReviewWorkItem, sources: ProjectedSnippet[]): void => {
    const availableCodeTokens = Math.max(64, opts.inputBudgetTokens - overhead - ruleTokenReserve);
    const perSourceBudget = Math.max(32, Math.floor(availableCodeTokens / Math.max(1, sources.length)));
    item.code = sources.flatMap((source) =>
      boundedMultiRegionSnippets(source, perSourceBudget, opts.profile, source.changedLineRanges ?? []),
    );
    item.changedRegions = sources.flatMap((source) =>
      (source.changedLineRanges ?? []).map((range) => ({ file: source.file, ...range })),
    );
    item.promptVisibleRanges = item.code.map((snippet) => ({
      file: snippet.file,
      start: snippet.startLine,
      end: snippet.endLine,
    }));
    item.rules = selectRules(opts.rules, item, opts.policy.maxRulesPerUnit);
    item.estimatedTokens =
      overhead +
      item.code.reduce((sum, code) => sum + code.estimatedTokens, 0) +
      item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
    locals.push(item);
  };
  for (const symbol of changedSymbols) {
    if (
      hasScoutTargets &&
      !hotspotSymbols.has(symbolKey(symbol)) &&
      !hotspotSymbols.has(symbol.qualifiedName) &&
      !hotspotSymbols.has(symbol.name)
    )
      continue;
    const sources = bySymbol.get(symbolKey(symbol)) ?? [];
    if (!sources.length) continue;
    const factors = factorsFor(symbolKey(symbol));
    {
      const item: ReviewWorkItem = {
        id: `local:${sha({ symbol: symbolKey(symbol) })}`,
        kind: "local",
        priority: filePriority(symbol.file) + symbolPriority(symbol, opts.graph.nodes),
        primarySymbols: [symbol],
        relatedSymbols: changedSymbols.filter(
          (related) =>
            related !== symbol &&
            related.file === symbol.file &&
            related.startLine >= symbol.startLine &&
            related.endLine <= symbol.endLine,
        ),
        code: [],
        graphEdges: graphEdges.filter((edge) => edge.source === symbolKey(symbol) || edge.target === symbolKey(symbol)),
        rules: [],
        deterministicReport,
        contextSummaries: [...opts.projection.dependencySummary, ...opts.projection.contextSummary],
        estimatedTokens: 0,
        rankFactors: {
          semanticRisk: filePriority(symbol.file) + symbolPriority(symbol, opts.graph.nodes),
          edgeRisk: 0,
          changedEndpoints: 1,
          productionSurface: filePriority(symbol.file) >= 90 ? 1 : 0,
          changedLines: sources
            .flatMap((source) => source.changedLineRanges ?? [])
            .reduce((sum, value) => sum + value.end - value.start + 1, 0),
          graphDegree: factors.neighborDegree,
          ...factors,
          degreeContribution: graphDegreeContribution(factors.neighborDegree),
        },
      };
      addLocal(item, sources);
    }
  }
  for (const code of opts.projection.code.filter((item) => item.changed && !item.symbol)) {
    const item: ReviewWorkItem = {
      id: `local:${code.id}`,
      kind: "local",
      priority: filePriority(code.file) + code.score,
      primarySymbols: [],
      relatedSymbols: [],
      code: [],
      graphEdges: [],
      rules: [],
      deterministicReport,
      contextSummaries: [...opts.projection.dependencySummary, ...opts.projection.contextSummary],
      estimatedTokens: 0,
      rankFactors: {
        semanticRisk: filePriority(code.file) + code.score,
        edgeRisk: 0,
        changedEndpoints: 1,
        productionSurface: filePriority(code.file) >= 90 ? 1 : 0,
        changedLines: (code.changedLineRanges ?? []).reduce((sum, value) => sum + value.end - value.start + 1, 0),
        graphDegree: 0,
        fanIn: 0,
        fanOut: 0,
        neighborDegree: 0,
        directedIncidentDegree: 0,
        degreeContribution: 0,
      },
    };
    addLocal(item, [code]);
  }
  const interactions: ReviewWorkItem[] = [];
  const fanout = new Map<string, number>();
  const changed = new Set(changedSymbols.map(symbolKey));
  const rankedEdges = [...graphEdges].sort((left, right) => {
    return (
      interactionPriority(right, changed, hotspotSymbols) - interactionPriority(left, changed, hotspotSymbols) ||
      left.source.localeCompare(right.source) ||
      (left.target ?? left.targetText).localeCompare(right.target ?? right.targetText) ||
      left.kind.localeCompare(right.kind)
    );
  });
  const neighborLimit = Math.min(
    opts.policy.maxUnitsPerChangedSymbol,
    opts.maxInteractionNeighborsPerSymbol ?? opts.policy.maxUnitsPerChangedSymbol,
  );
  const groups = new Map<string, GraphContextEdge[]>();
  for (const edge of rankedEdges) {
    if (!edge.target) continue;
    if (
      hasScoutTargets &&
      !hotspotEdgeKinds.has(edge.kind) &&
      !hotspotSymbols.has(edge.source) &&
      !hotspotSymbols.has(edge.target)
    )
      continue;
    const changedEndpoints = [edge.source, edge.target].filter((endpoint): endpoint is string =>
      Boolean(endpoint && changed.has(endpoint)),
    );
    if (!changedEndpoints.length) continue;
    const clusterKey = `${[...changedEndpoints].sort()[0]}:${interactionFamily(edge.kind)}`;
    const group = groups.get(clusterKey) ?? [];
    if (group.length < neighborLimit) group.push(edge);
    groups.set(clusterKey, group);
  }
  for (const edges of groups.values()) {
    const primaryKeys = [
      ...new Set(edges.flatMap((edge) => [edge.source, edge.target!]).filter((key) => changed.has(key))),
    ];
    if (!primaryKeys.length) continue;
    if (primaryKeys.every((key) => (fanout.get(key) ?? 0) >= neighborLimit)) continue;
    const allKeys = [...new Set(edges.flatMap((edge) => [edge.source, edge.target!]))];
    const symbols = allKeys
      .map((key) => opts.graph.nodes.find((node) => symbolKey(node.symbol) === key)?.symbol)
      .filter((symbol): symbol is GraphSymbol => Boolean(symbol));
    const primarySymbols = symbols.filter((symbol) => changed.has(symbolKey(symbol)));
    const relatedSymbols = symbols.filter((symbol) => !changed.has(symbolKey(symbol)));
    const orderedSymbols = [...primarySymbols, ...relatedSymbols];
    const codes = orderedSymbols.flatMap((symbol) => bySymbol.get(symbolKey(symbol)) ?? []);
    if (orderedSymbols.length < 2 || !codes.length) continue;
    const edgeRisk = Math.max(...edges.map((edge) => interactionPriority(edge, changed, hotspotSymbols)));
    const factors = symbols.reduce(
      (current, symbol) => {
        const value = factorsFor(symbolKey(symbol));
        return {
          fanIn: Math.max(current.fanIn, value.fanIn),
          fanOut: Math.max(current.fanOut, value.fanOut),
          neighborDegree: Math.max(current.neighborDegree, value.neighborDegree),
          directedIncidentDegree: Math.max(current.directedIncidentDegree, value.directedIncidentDegree),
        };
      },
      { fanIn: 0, fanOut: 0, neighborDegree: 0, directedIncidentDegree: 0 },
    );
    const semanticRisk = edgeRisk + Math.max(...symbols.map((symbol) => symbolPriority(symbol, opts.graph.nodes)));
    const item: ReviewWorkItem = {
      id: `interaction:${sha({ edges: edges.map((edge) => `${edge.kind}:${edge.source}:${edge.target}`).sort() })}`,
      kind: "interaction",
      priority: semanticRisk,
      primarySymbols,
      relatedSymbols,
      code: [],
      graphEdges: edges,
      rules: [],
      deterministicReport,
      contextSummaries: [...opts.projection.dependencySummary, ...opts.projection.contextSummary],
      estimatedTokens: 0,
      rankFactors: {
        semanticRisk,
        edgeRisk,
        changedEndpoints: primarySymbols.length,
        productionSurface: Number(symbols.some((symbol) => filePriority(symbol.file) >= 90)),
        changedLines: codes
          .flatMap((code) => code.changedLineRanges ?? [])
          .reduce((sum, value) => sum + value.end - value.start + 1, 0),
        graphDegree: factors.neighborDegree,
        ...factors,
        degreeContribution: graphDegreeContribution(factors.neighborDegree),
      },
    };
    const availableCodeTokens = Math.max(128, opts.inputBudgetTokens - overhead - ruleTokenReserve);
    const symbolWeights = new Map(
      orderedSymbols.map((symbol) => [
        symbolKey(symbol),
        primarySymbols.some((primary) => symbolKey(primary) === symbolKey(symbol)) ? 1 : 3,
      ]),
    );
    const totalWeight = codes.reduce(
      (sum, code) => sum + (symbolWeights.get(code.symbol ? `${code.file}:${code.symbol}` : "") ?? 1),
      0,
    );
    item.code = codes.flatMap((code) => {
      const weight = symbolWeights.get(code.symbol ? `${code.file}:${code.symbol}` : "") ?? 1;
      const budget = Math.max(64, Math.floor((availableCodeTokens * weight) / totalWeight));
      return boundedMultiRegionSnippets(code, budget, opts.profile, code.changedLineRanges ?? []);
    });
    item.changedRegions = codes.flatMap((code) =>
      (code.changedLineRanges ?? []).map((range) => ({ file: code.file, ...range })),
    );
    item.promptVisibleRanges = item.code.map((snippet) => ({
      file: snippet.file,
      start: snippet.startLine,
      end: snippet.endLine,
    }));
    item.rules = selectRules(opts.rules, item, opts.policy.maxRulesPerUnit);
    item.estimatedTokens =
      overhead +
      item.code.reduce((sum, value) => sum + value.estimatedTokens, 0) +
      item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
    interactions.push(item);
    for (const key of primaryKeys) fanout.set(key, (fanout.get(key) ?? 0) + 1);
  }
  return uniqueWorkItems([...locals, ...interactions]);
}

export function extensionLanguage(file: string) {
  const extension = path.extname(file);
  return /\.(ts|tsx|js|jsx)$/.test(extension)
    ? "typescript"
    : /\.(py|pyi)$/.test(extension)
      ? "python"
      : extension.slice(1);
}
