import crypto from "node:crypto";
import path from "node:path";
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

function sha(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
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

interface ChangedRange {
  file: string;
  start: number;
  end: number;
}

export function changedRanges(diff: string): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    const diffHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffHeader) file = diffHeader[2];
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) file = header[1];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file && hunk) {
      const newCount = Number(hunk[4] ?? 1);
      const useOldSide = newCount === 0;
      const start = Number(useOldSide ? hunk[1] : hunk[3]);
      const count = Number(useOldSide ? (hunk[2] ?? 1) : newCount);
      ranges.push({ file, start, end: Math.max(start, start + count - 1) });
    }
  }
  return ranges;
}

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

function fallbackSnippets(scope: ReviewScope, profile: ModelProfile, symbolFiles: Set<string>): ProjectedSnippet[] {
  const ranges = changedRanges(scope.diff);
  const snippets: ProjectedSnippet[] = [];
  for (const entry of scope.manifest ?? []) {
    if (entry.binary || entry.generated || (entry.sizeBytes ?? 0) > 300_000 || symbolFiles.has(entry.path)) continue;
    const content = scope.fileContents[entry.path] ?? "";
    const fileRanges = ranges.filter((range) => range.file === entry.path);
    if (!fileRanges.length && content)
      snippets.push(
        snippet(entry.path, content, 1, content.split("\n").length, profile, {
          changed: true,
          score: 120,
          reason: "changed file without semantic symbol boundary",
        }),
      );
    for (const range of fileRanges)
      snippets.push(
        snippet(entry.path, content, Math.max(1, range.start - 12), range.end + 12, profile, {
          changed: true,
          score: 120,
          reason: "changed hunk fallback with surrounding context",
        }),
      );
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
  code.push(
    ...fallbackSnippets(opts.scope, opts.profile, new Set(opts.graph.changedSymbols.map((symbol) => symbol.file))),
  );
  const unique = [...new Map(code.map((item) => [item.id, item])).values()].sort(
    (left, right) =>
      right.score - left.score || left.file.localeCompare(right.file) || left.startLine - right.startLine,
  );
  const projectedCode = opts.kind === "compact" ? unique.map((item) => compactSnippet(item, opts.profile)) : unique;
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
    metadata: { base: opts.scope.base, snapshotId: opts.scope.id, languages: opts.scope.languages ?? [] },
    audit: [],
    omissions: [
      ...(opts.scope.omissions ?? []),
      ...(opts.scope.manifest ?? [])
        .filter(
          (entry) =>
            (entry.sizeBytes ?? 0) > 300_000 && !opts.graph.changedSymbols.some((symbol) => symbol.file === entry.path),
        )
        .map((entry) => ({
          kind: "file" as const,
          id: entry.path,
          reason: "unsafe-large-file" as const,
          details: "file exceeds 300000 bytes and has no safe semantic projection",
        })),
    ],
  };
  base.rules = selectRules(opts.rules, base, Number.POSITIVE_INFINITY, opts.kind === "full");
  const manifestText = JSON.stringify(base.manifest);
  const fixed =
    estimateTokens(manifestText, opts.profile, false) +
    estimateTokens(graphSummary, opts.profile, false) +
    estimateTokens(opts.deterministicReport ?? "", opts.profile, false) +
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

function symbolKey(symbol: GraphSymbol) {
  return `${symbol.file}:${symbol.qualifiedName}`;
}
function interactionPriority(edge: GraphContextEdge, changed: Set<string>, hot: Set<string>) {
  const base =
    edge.kind === "implements" || edge.kind === "extends"
      ? 100
      : ["schema-user", "serialization", "producer-consumer", "config"].includes(edge.kind)
        ? 90
        : edge.kind === "calls"
          ? 80
          : edge.kind === "reads-type" || edge.kind === "references"
            ? 70
            : edge.kind === "test-reference"
              ? 40
              : edge.kind === "imports"
                ? 10
                : 20;
  return (
    base +
    (edge.target && changed.has(edge.source) && changed.has(edge.target) ? 30 : 0) +
    (edge.confidence === "exact" ? 10 : 0) +
    (hot.has(edge.source) || (edge.target ? hot.has(edge.target) : false) ? 50 : 0)
  );
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

export function selectWorkItems(items: ReviewWorkItem[], limit: number, tokenBudget = Number.POSITIVE_INFINITY) {
  const ranked = [...items].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  const selected: ReviewWorkItem[] = [];
  const omitted: ReviewWorkItem[] = [];
  const tokenOmitted: ReviewWorkItem[] = [];
  let usedTokens = 0;
  for (const item of ranked) {
    if (selected.length >= Math.max(0, limit)) {
      omitted.push(item);
      continue;
    }
    if (usedTokens + item.estimatedTokens > tokenBudget) {
      omitted.push(item);
      tokenOmitted.push(item);
      continue;
    }
    selected.push(item);
    usedTokens += item.estimatedTokens;
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
  const bySymbol = new Map(
    opts.projection.code.filter((code) => code.symbol).map((code) => [`${code.file}:${code.symbol}`, code]),
  );
  const deterministicReport = opts.projection.deterministicReport?.slice(0, 2000);
  const overhead = 900 + estimateTokens(deterministicReport ?? "", opts.profile, false);
  const ruleReserve = Math.min(1200, Math.floor(opts.inputBudgetTokens * 0.2));
  const codeBudget = Math.max(128, opts.inputBudgetTokens - overhead - ruleReserve);
  const hotspotSymbols = new Set(
    (opts.hotspots ?? []).flatMap((hotspot) => [...hotspot.symbols, ...hotspot.requestedInspection.symbols]),
  );
  const hotspotEdgeKinds = new Set(
    (opts.hotspots ?? []).flatMap((hotspot) => hotspot.requestedInspection.edgeKinds ?? []),
  );
  const hasScoutTargets = Boolean(opts.hotspots?.length && (hotspotSymbols.size || hotspotEdgeKinds.size));
  const locals: ReviewWorkItem[] = [];
  for (const symbol of opts.graph.changedSymbols) {
    if (
      hasScoutTargets &&
      !hotspotSymbols.has(symbolKey(symbol)) &&
      !hotspotSymbols.has(symbol.qualifiedName) &&
      !hotspotSymbols.has(symbol.name)
    )
      continue;
    const source = bySymbol.get(symbolKey(symbol));
    if (!source) continue;
    const slices =
      source.estimatedTokens > codeBudget && source.changedLineRanges?.length ? source.changedLineRanges : [undefined];
    for (const range of slices) {
      const item: ReviewWorkItem = {
        id: `local:${sha({ symbol: symbolKey(symbol), range })}`,
        kind: "local",
        priority: filePriority(symbol.file) + symbolPriority(symbol, opts.graph.nodes),
        primarySymbols: [symbol],
        relatedSymbols: [],
        code: [boundedSnippet(source, codeBudget, opts.profile, range)],
        graphEdges: opts.graph.edges.filter(
          (edge) => edge.source === symbolKey(symbol) || edge.target === symbolKey(symbol),
        ),
        rules: [],
        deterministicReport,
        estimatedTokens: 0,
      };
      item.rules = selectRules(opts.rules, item, opts.policy.maxRulesPerUnit);
      const availableCodeTokens = Math.max(
        64,
        opts.inputBudgetTokens - overhead - item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0),
      );
      item.code = [boundedSnippet(source, availableCodeTokens, opts.profile, range)];
      item.estimatedTokens =
        overhead +
        item.code.reduce((sum, code) => sum + code.estimatedTokens, 0) +
        item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
      locals.push(item);
    }
  }
  for (const code of opts.projection.code.filter((item) => item.changed && !item.symbol)) {
    const item: ReviewWorkItem = {
      id: `local:${code.id}`,
      kind: "local",
      priority: filePriority(code.file) + code.score,
      primarySymbols: [],
      relatedSymbols: [],
      code: [boundedSnippet(code, codeBudget, opts.profile)],
      graphEdges: [],
      rules: [],
      deterministicReport,
      estimatedTokens: 0,
    };
    item.rules = selectRules(opts.rules, item, opts.policy.maxRulesPerUnit);
    const availableCodeTokens = Math.max(
      64,
      opts.inputBudgetTokens - overhead - item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0),
    );
    item.code = [boundedSnippet(code, availableCodeTokens, opts.profile)];
    item.estimatedTokens =
      overhead +
      item.code.reduce((sum, value) => sum + value.estimatedTokens, 0) +
      item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
    locals.push(item);
  }
  const interactions: ReviewWorkItem[] = [];
  const fanout = new Map<string, number>();
  const changed = new Set(opts.graph.changedSymbols.map(symbolKey));
  const rankedEdges = [...opts.graph.edges].sort((left, right) => {
    return (
      interactionPriority(right, changed, hotspotSymbols) - interactionPriority(left, changed, hotspotSymbols) ||
      left.source.localeCompare(right.source) ||
      (left.target ?? left.targetText).localeCompare(right.target ?? right.targetText)
    );
  });
  for (const edge of rankedEdges) {
    const primaryKey = changed.has(edge.source)
      ? edge.source
      : edge.target && changed.has(edge.target)
        ? edge.target
        : undefined;
    if (!primaryKey || !edge.target) continue;
    if (
      hasScoutTargets &&
      !hotspotEdgeKinds.has(edge.kind) &&
      !hotspotSymbols.has(edge.source) &&
      !hotspotSymbols.has(edge.target)
    )
      continue;
    const neighborLimit = Math.min(
      opts.policy.maxUnitsPerChangedSymbol,
      opts.maxInteractionNeighborsPerSymbol ?? opts.policy.maxUnitsPerChangedSymbol,
    );
    if ((fanout.get(primaryKey) ?? 0) >= neighborLimit) continue;
    const primary = opts.graph.nodes.find((node) => symbolKey(node.symbol) === primaryKey)?.symbol;
    const otherKey = edge.source === primaryKey ? edge.target : edge.source;
    const related = opts.graph.nodes.find((node) => symbolKey(node.symbol) === otherKey)?.symbol;
    const primaryCode = bySymbol.get(primaryKey);
    const relatedCode = bySymbol.get(otherKey);
    if (!primary || !related || !primaryCode || !relatedCode) continue;
    const perSnippet = Math.max(128, Math.floor(codeBudget / 2));
    const item: ReviewWorkItem = {
      id: `interaction:${sha({ primaryKey, otherKey, kind: edge.kind })}`,
      kind: "interaction",
      priority:
        interactionPriority(edge, changed, hotspotSymbols) +
        symbolPriority(primary, opts.graph.nodes) +
        symbolPriority(related, opts.graph.nodes),
      primarySymbols: [primary],
      relatedSymbols: [related],
      code: [
        boundedSnippet(primaryCode, perSnippet, opts.profile),
        boundedSnippet(relatedCode, perSnippet, opts.profile),
      ],
      graphEdges: [edge],
      rules: [],
      deterministicReport,
      estimatedTokens: 0,
    };
    item.rules = selectRules(opts.rules, item, opts.policy.maxRulesPerUnit);
    const availableCodeTokens = Math.max(
      128,
      opts.inputBudgetTokens - overhead - item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0),
    );
    const availablePerSnippet = Math.max(64, Math.floor(availableCodeTokens / 2));
    item.code = [
      boundedSnippet(primaryCode, availablePerSnippet, opts.profile),
      boundedSnippet(relatedCode, availablePerSnippet, opts.profile),
    ];
    item.estimatedTokens =
      overhead +
      item.code.reduce((sum, value) => sum + value.estimatedTokens, 0) +
      item.rules.reduce((sum, rule) => sum + rule.estimatedTokens, 0);
    interactions.push(item);
    fanout.set(primaryKey, (fanout.get(primaryKey) ?? 0) + 1);
  }
  return [...locals, ...interactions];
}

export function extensionLanguage(file: string) {
  const extension = path.extname(file);
  return /\.(ts|tsx|js|jsx)$/.test(extension)
    ? "typescript"
    : /\.(py|pyi)$/.test(extension)
      ? "python"
      : extension.slice(1);
}
