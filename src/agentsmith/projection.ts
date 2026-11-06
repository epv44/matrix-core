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
  const focusStart = range ? Math.max(0, range.start - item.startLine) : 0;
  const focusEnd = range ? Math.min(lines.length, range.end - item.startLine + 1) : lines.length;
  // Start from the focus hunk and expand context outward. Never shrink below the
  // focus while unused budget remains — equal inward trimming can lock onto a
  // too-small window that permanently drops later changed lines.
  let localStart = focusStart;
  let localEnd = Math.max(focusStart + 1, focusEnd);
  let content = lines.slice(localStart, localEnd).join("\n");
  if (content.length <= maxChars) {
    const contextPad = 12;
    const desiredStart = range ? Math.max(0, focusStart - contextPad) : 0;
    const desiredEnd = range ? Math.min(lines.length, focusEnd + contextPad) : lines.length;
    while (localStart > desiredStart || localEnd < desiredEnd) {
      const expandStart = localStart > desiredStart;
      const expandEnd = localEnd < desiredEnd;
      const nextStart = expandStart && (!expandEnd || localStart - desiredStart >= desiredEnd - localEnd)
        ? localStart - 1
        : localStart;
      const nextEnd = nextStart === localStart && expandEnd ? localEnd + 1 : localEnd;
      if (nextStart === localStart && nextEnd === localEnd) break;
      const next = lines.slice(nextStart, nextEnd).join("\n");
      if (next.length > maxChars) break;
      localStart = nextStart;
      localEnd = nextEnd;
      content = next;
    }
  } else {
    // Focus core overflows: keep the start of the focus range (defect anchors are
    // usually near the first changed lines of a hunk).
    while (content.length > maxChars && localEnd > localStart + 1) {
      localEnd--;
      content = lines.slice(localStart, localEnd).join("\n");
    }
    if (content.length > maxChars) content = content.slice(0, maxChars);
  }
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

function focusRangeTokenEstimate(
  item: ProjectedSnippet,
  range: { start: number; end: number },
  profile: ModelProfile,
): number {
  const lines = item.content.split("\n");
  const localStart = Math.max(0, range.start - item.startLine);
  const localEnd = Math.min(lines.length, range.end - item.startLine + 1);
  return Math.max(1, estimateTokens(lines.slice(localStart, Math.max(localStart + 1, localEnd)).join("\n"), profile));
}

function boundedMultiRegionSnippets(
  item: ProjectedSnippet,
  budget: number,
  profile: ModelProfile,
  ranges: Array<{ start: number; end: number }> = item.changedLineRanges ?? [],
): ProjectedSnippet[] {
  if (item.estimatedTokens <= budget || !ranges.length) return [boundedSnippet(item, budget, profile, ranges[0])];
  const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const spanWeights = ordered.map((range) => Math.max(1, range.end - range.start + 1));
  const spanTotal = spanWeights.reduce((sum, value) => sum + value, 0);
  let remaining = budget;
  const snippets = ordered.map((range, index) => {
    const regionsLeft = ordered.length - index;
    const proportional = Math.max(32, Math.floor((budget * spanWeights[index]) / spanTotal));
    const focusNeed = focusRangeTokenEstimate(item, range, profile);
    // Prefer covering each focus core; never leave later regions with a useless floor
    // while earlier tiny ranges consume equal shares.
    const reservedForRest = 32 * (regionsLeft - 1);
    const alloc =
      index === ordered.length - 1
        ? remaining
        : Math.min(remaining - reservedForRest, Math.max(proportional, Math.min(focusNeed, remaining - reservedForRest)));
    const use = Math.max(32, Math.min(remaining, alloc));
    remaining = Math.max(0, remaining - use);
    return boundedSnippet(item, use, profile, range);
  });
  return [
    ...new Map(
      snippets.map((snippet) => [
        `${snippet.file}:${snippet.startLine}:${snippet.endLine}:${snippet.content}`,
        snippet,
      ]),
    ).values(),
  ];
}

/** Distribute a code budget so high-priority foci are filled before leftovers. */
function allocateSnippetBudgets(
  entries: Array<{ key: string; priority: number; focusNeed: number; fallback: number }>,
  available: number,
): Map<string, number> {
  const budgets = new Map<string, number>();
  if (!entries.length) return budgets;
  let remaining = Math.max(0, available);
  const ordered = [...entries].sort(
    (left, right) =>
      right.priority - left.priority || right.focusNeed - left.focusNeed || left.key.localeCompare(right.key),
  );
  for (const entry of ordered) {
    const others = ordered.length - budgets.size - 1;
    const reserve = Math.max(0, others * 32);
    const need = Math.max(entry.focusNeed, entry.fallback);
    const give = Math.max(32, Math.min(remaining - reserve, need));
    budgets.set(entry.key, give);
    remaining = Math.max(0, remaining - give);
  }
  if (remaining > 0 && ordered.length) {
    const head = ordered[0];
    budgets.set(head.key, (budgets.get(head.key) ?? 0) + remaining);
  }
  return budgets;
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

/** Content tokens that vary per work item; shared prompt overhead is packed once. */
function workItemContentTokens(item: ReviewWorkItem): number {
  const fromParts =
    item.code.reduce((sum, code) => sum + code.estimatedTokens, 0) +
    item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
  if (item.code.length || item.rules.length) return fromParts;
  return item.estimatedTokens;
}

function workItemSharedOverheadTokens(item: ReviewWorkItem): number {
  if (!(item.code.length || item.rules.length)) return 0;
  return Math.max(0, item.estimatedTokens - workItemContentTokens(item));
}

/** Aggregate packing cost: charge shared overhead once, then per-item content. */
function packingChargeTokens(item: ReviewWorkItem, sharedOverheadCharged: boolean): {
  cost: number;
  chargesOverhead: boolean;
} {
  const content = workItemContentTokens(item);
  const overhead = workItemSharedOverheadTokens(item);
  if (!sharedOverheadCharged && overhead > 0) return { cost: overhead + content, chargesOverhead: true };
  if (overhead > 0) return { cost: Math.max(1, content), chargesOverhead: false };
  return { cost: item.estimatedTokens, chargesOverhead: false };
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
  const pairRankScore = (left: ReviewWorkItem, right: ReviewWorkItem) =>
    (incomingRank.get(left.id) ?? Number.POSITIVE_INFINITY) + (incomingRank.get(right.id) ?? Number.POSITIVE_INFINITY);
  const selected: ReviewWorkItem[] = [];
  const omitted: ReviewWorkItem[] = [];
  const tokenOmitted: ReviewWorkItem[] = [];
  let usedTokens = 0;
  let sharedOverheadCharged = false;
  const tryCharge = (item: ReviewWorkItem) => packingChargeTokens(item, sharedOverheadCharged);
  const commitCharge = (item: ReviewWorkItem) => {
    const charge = tryCharge(item);
    usedTokens += charge.cost;
    if (charge.chargesOverhead) sharedOverheadCharged = true;
  };
  if (limit >= 2) {
    const locals = ranked.filter((item) => item.kind === "local");
    const interactions = ranked.filter((item) => item.kind === "interaction");
    let pair: [ReviewWorkItem, ReviewWorkItem] | undefined;
    let bestPairScore = Number.POSITIVE_INFINITY;
    for (const local of locals) {
      for (const interaction of interactions) {
        const localCharge = packingChargeTokens(local, false);
        const interactionCharge = packingChargeTokens(interaction, localCharge.chargesOverhead);
        if (localCharge.cost + interactionCharge.cost > tokenBudget) continue;
        const score = pairRankScore(local, interaction);
        if (!pair || score < bestPairScore) {
          pair = [local, interaction];
          bestPairScore = score;
        }
      }
    }
    if (pair) {
      selected.push(...pair.sort(compareIncomingRank));
      for (const item of selected)
        item.selectionReason = `required-${item.kind}; priority=${item.priority ?? 0}; semantic=${workItemSemanticKey(item)}`;
      for (const item of selected) commitCharge(item);
    }
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  while (selected.length < Math.max(0, limit)) {
    const remaining = ranked.filter((item) => !selectedIds.has(item.id));
    const fitting = remaining.filter((item) => usedTokens + tryCharge(item).cost <= tokenBudget);
    if (!fitting.length) break;
    const item = fitting[0];
    item.selectionReason = `ranked-fill; rank=${item.rank ?? incomingRank.get(item.id) ?? "unknown"}; semantic=${workItemSemanticKey(item)}`;
    selected.push(item);
    selectedIds.add(item.id);
    commitCharge(item);
  }
  const budgetLimited = selected.length < Math.max(0, limit);
  for (const item of ranked.filter((entry) => !selectedIds.has(entry.id))) {
    omitted.push(item);
    if (budgetLimited && usedTokens + tryCharge(item).cost > tokenBudget) {
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
    // Locals keep a stricter chrome reserve so giant single-file symbols cannot
    // inflate packing costs and crowd out interaction pairs under the aggregate budget.
    const availableCodeTokens = Math.max(128, opts.inputBudgetTokens - overhead - ruleTokenReserve);
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
    const seedCodes = orderedSymbols.flatMap((symbol) => bySymbol.get(symbolKey(symbol)) ?? []);
    if (orderedSymbols.length < 2 || !seedCodes.length) continue;
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
        changedLines: seedCodes
          .flatMap((code) => code.changedLineRanges ?? [])
          .reduce((sum, value) => sum + value.end - value.start + 1, 0),
        graphDegree: factors.neighborDegree,
        ...factors,
        degreeContribution: graphDegreeContribution(factors.neighborDegree),
      },
    };
    // Cap shared chrome so dense JSX/type evidence is not starved when the
    // deterministic report is large. Packing still accounts for full overhead.
    const chromeReserve = Math.min(overhead, Math.max(700, Math.floor(opts.inputBudgetTokens * 0.4)));
    const availableCodeTokens = Math.max(256, opts.inputBudgetTokens - chromeReserve - ruleTokenReserve);
    // Nested changed symbols inside a primary (e.g. a one-line const in a large card)
    // are cheap, high-precision defect anchors. Prefer them over the bulky parent body
    // so related contract types still receive enough budget for their evidence.
    const nestedChanged = changedSymbols.filter((symbol) =>
      primarySymbols.some(
        (primary) =>
          symbolKey(symbol) !== symbolKey(primary) &&
          symbol.file === primary.file &&
          symbol.startLine >= primary.startLine &&
          symbol.endLine <= primary.endLine,
      ),
    );
    const nestedKeys = new Set(nestedChanged.map(symbolKey));
    const nestedCodes = nestedChanged.flatMap((symbol) => bySymbol.get(symbolKey(symbol)) ?? []);
    const subtractRanges = (
      ranges: Array<{ start: number; end: number }>,
      coveredBy: Array<{ startLine: number; endLine: number }>,
    ) => {
      let open = ranges.map((range) => ({ ...range }));
      for (const cover of coveredBy) {
        const next: Array<{ start: number; end: number }> = [];
        for (const range of open) {
          if (cover.endLine < range.start || cover.startLine > range.end) {
            next.push(range);
            continue;
          }
          if (cover.startLine > range.start) next.push({ start: range.start, end: cover.startLine - 1 });
          if (cover.endLine < range.end) next.push({ start: cover.endLine + 1, end: range.end });
        }
        open = next.filter((range) => range.end >= range.start);
      }
      return open;
    };
    // Prefer nested changed anchors, but keep any parent changed lines they do not
    // cover (e.g. a guard on the next line beside a nested const).
    const endpointCodes = orderedSymbols.flatMap((symbol) => {
      const codesForSymbol = bySymbol.get(symbolKey(symbol)) ?? [];
      if (!primarySymbols.some((primary) => symbolKey(primary) === symbolKey(symbol))) return codesForSymbol;
      const nested = nestedChanged.filter(
        (entry) =>
          entry.file === symbol.file &&
          entry.startLine >= symbol.startLine &&
          entry.endLine <= symbol.endLine,
      );
      if (!nested.length) return codesForSymbol;
      return codesForSymbol.flatMap((code) => {
        const uncovered = subtractRanges(code.changedLineRanges ?? [], nested);
        // Keep only uncovered parent lines near a nested anchor (e.g. a guard on
        // the next line). Far-away leftover hunks re-introduce bulky parent bodies.
        const pad = 2;
        const nearNested = uncovered.flatMap((range) => {
          const slices: Array<{ start: number; end: number }> = [];
          for (const entry of nested) {
            const start = Math.max(range.start, entry.startLine - pad);
            const end = Math.min(range.end, entry.endLine + pad);
            if (end >= start) slices.push({ start, end });
          }
          return slices;
        });
        if (!nearNested.length) return [];
        return [{ ...code, changedLineRanges: nearNested }];
      });
    });
    const interactionCodes = [
      ...new Map(
        [...nestedCodes, ...endpointCodes].map((code) => [
          `${code.file}:${code.symbol ?? ""}:${code.startLine}:${code.endLine}:${JSON.stringify(code.changedLineRanges ?? [])}`,
          code,
        ]),
      ).values(),
    ];
    const relatedPrefixNeed = Math.max(
      96,
      Math.ceil((60 * 40) / Math.max(1, opts.profile.tokenizer.codeCharsPerToken)),
    );
    const budgetEntries = interactionCodes.map((code) => {
      const key = `${code.file}:${code.symbol ?? ""}:${code.startLine}:${code.endLine}`;
      const codeSymbolKey = code.symbol ? `${code.file}:${code.symbol}` : "";
      const nested = Boolean(codeSymbolKey && nestedKeys.has(codeSymbolKey));
      const primary = primarySymbols.some((symbol) => symbolKey(symbol) === codeSymbolKey);
      const ranges = code.changedLineRanges ?? [];
      const focusNeed = ranges.length
        ? ranges.reduce((sum, range) => sum + focusRangeTokenEstimate(code, range, opts.profile), 0)
        : primary || nested
          ? code.estimatedTokens
          : Math.min(code.estimatedTokens, Math.max(relatedPrefixNeed, Math.ceil(code.estimatedTokens * 0.35)));
      return {
        key,
        code,
        // Prefer nested anchors, then primary bodies, then larger related contracts
        // (edge targets) over tiny type aliases that only consume chrome.
        priority: nested ? 50 : primary ? 30 : 10 + Math.min(20, Math.floor(code.estimatedTokens / 50)),
        focusNeed: Math.max(32, focusNeed),
        fallback: nested ? 48 : primary ? 128 : relatedPrefixNeed,
      };
    });
    const budgets = allocateSnippetBudgets(
      budgetEntries.map(({ key, priority, focusNeed, fallback }) => ({ key, priority, focusNeed, fallback })),
      availableCodeTokens,
    );
    item.code = budgetEntries.flatMap(({ key, code }) =>
      boundedMultiRegionSnippets(code, budgets.get(key) ?? 64, opts.profile, code.changedLineRanges ?? []),
    );
    item.changedRegions = interactionCodes.flatMap((code) =>
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
