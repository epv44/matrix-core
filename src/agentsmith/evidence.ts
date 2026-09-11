import fs from "node:fs";
import path from "node:path";
import type {
  CandidateFinding,
  EvidencePolicy,
  EvidenceRecord,
  EvidenceRequest,
  EvidenceResolutionOutcome,
} from "../core/types.js";
import type { GraphContext } from "../core/graph/types.js";
import type { ReviewScope } from "./scope.js";
import { changedRanges } from "./projection.js";
import { parseAddedLineRanges } from "../core/diff.js";
import { sha256, sha256Json } from "../core/hash.js";
import { discoverGraphFiles } from "../core/graph/providers.js";

function safePath(root: string, value: string) {
  const relative = path.normalize(value).replaceAll("\\", "/").replace(/^\.\//, "");
  const absolute = path.resolve(root, relative);
  return absolute === root || absolute.startsWith(root + path.sep) ? { relative, absolute } : undefined;
}

function normalizedRepositoryPath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function evidenceLocatorParts(request: EvidenceRequest): {
  pathHint?: string;
  symbolCandidates: string[];
  textQueries: string[];
  symbolLocatorValid: boolean;
} {
  const locator = (request.symbol ?? request.query ?? "").trim().replace(/^`|`$/g, "");
  const embeddedPath = locator.match(
    /(?:^|\s)((?:\.\.\/|\.\/)?(?:[\w@.-]+\/)+[\w@.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|sql|ya?ml|json|toml))(?:[:#]([^\s]+))?/i,
  );
  const pathHint = request.pathHint ?? embeddedPath?.[1];
  const withoutPath = embeddedPath
    ? [
        locator.slice(0, embeddedPath.index),
        embeddedPath[2] ?? "",
        locator.slice((embeddedPath.index ?? 0) + embeddedPath[0].length),
      ]
        .join(" ")
        .trim()
    : locator;
  const beforeDescription = withoutPath
    .replace(/\s+(?:return|parameter|property|field|function|method)\s+type\b.*$/i, "")
    .trim();
  const emptyCallNormalized = beforeDescription.replace(/\(\s*\)$/, "").trim();
  const expressionShaped = /[()=,+*?\[\]{}'"`]/.test(emptyCallNormalized);
  const beforeCall = expressionShaped ? "" : emptyCallNormalized;
  const identifiers = beforeCall.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const symbolCandidates = [beforeCall, identifiers.at(-1) ?? ""]
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && !value.startsWith("{") && !value.includes(" "));
  const textQueries = [locator, beforeDescription, beforeCall, identifiers.at(-1) ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && value.length <= 200);
  return {
    pathHint: pathHint ? normalizedRepositoryPath(pathHint) : undefined,
    symbolCandidates: [...new Set(symbolCandidates)],
    textQueries: [...new Set(textQueries)],
    symbolLocatorValid: !expressionShaped && symbolCandidates.length > 0,
  };
}

export function evidenceRequestId(request: EvidenceRequest): string {
  return sha256Json(
    {
      kind: request.kind,
      locatorId: request.locatorId ?? "",
      taskId: request.taskId ?? "",
      snapshotId: request.snapshotId ?? "",
      locatorMode: request.locatorMode ?? "",
      symbol: request.symbol ?? "",
      pathHint: request.pathHint ?? "",
      query: request.query ?? "",
    },
    16,
  );
}

function record(
  requestId: string,
  request: EvidenceRequest,
  file: string,
  startLine: number,
  lines: string[],
  symbol?: string,
  relation?: string,
  matchedLocator?: string,
): EvidenceRecord {
  const snippet = lines.join("\n");
  const id = sha256Json({ requestId, file, startLine, snippet, symbol }, 16);
  return {
    id,
    locatorId: request.locatorId,
    taskId: request.taskId,
    snapshotId: request.snapshotId,
    requestKind: request.kind,
    file,
    startLine,
    endLine: startLine + lines.length - 1,
    symbol,
    snippet,
    relation,
    requestId,
    matchedLocator,
    reason: request.reason,
  };
}

function readLines(scope: ReviewScope, file: string): string[] {
  const captured = scope.fileContents[file] ?? scope.suppliedContext[file];
  if (captured !== undefined) return captured.split("\n");
  const resolved = safePath(scope.root, file);
  if (!resolved) return [];
  try {
    return fs.readFileSync(resolved.absolute, "utf8").split("\n");
  } catch {
    return [];
  }
}

function evidenceSearchFiles(scope: ReviewScope): string[] {
  const discovered = discoverGraphFiles(scope.root).map((file) => file.path);
  return [...new Set([...scope.changedFiles, ...Object.keys(scope.suppliedContext), ...discovered])].filter(
    (file) =>
      !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|node_modules|dist|build|coverage)\//.test(
        `${file}/`,
      ) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file),
  );
}

function symbolMatchesSnapshot(scope: ReviewScope, symbol: { file: string; contentHash: string }): boolean {
  const source = scope.fileContents[symbol.file] ?? scope.suppliedContext[symbol.file];
  if (source !== undefined && /^[a-f0-9]{64}$/i.test(symbol.contentHash)) return sha256(source) === symbol.contentHash;
  const discovered = discoverGraphFiles(scope.root).find((file) => file.path === symbol.file);
  return !discovered || !/^[a-f0-9]{64}$/i.test(symbol.contentHash) || discovered.contentHash === symbol.contentHash;
}

function searchRoleScore(file: string, kind: EvidenceRequest["kind"]): number {
  const test = /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[^.]+$/.test(file);
  if (kind === "test") return test ? 100 : 0;
  if (kind === "implementation" || kind === "definition" || kind === "type") return test ? 0 : 100;
  return test ? 20 : 50;
}

function enclosingSymbol(symbols: GraphContext["nodes"][number]["symbol"][], file: string, line: number) {
  return symbols
    .filter((symbol) => symbol.file === file && symbol.startLine <= line && symbol.endLine >= line)
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0];
}

function lexicalOwner(lines: string[], index: number): { name: string; kind: string } | undefined {
  for (let current = index; current >= 0; current--) {
    const python = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(lines[current]);
    if (python) return { name: python[2], kind: python[1] === "class" ? "class" : "function" };
    const typescript = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(
      lines[current],
    );
    if (typescript) return { name: typescript[2], kind: typescript[1] };
  }
  return undefined;
}

function literalHitScore(opts: {
  file: string;
  line: string;
  query: string;
  request: EvidenceRequest;
  pathHint?: string;
  owner?: { name: string; kind: string };
}) {
  const exactLiteral = opts.line.includes(`"${opts.query}"`) || opts.line.includes(`'${opts.query}'`);
  const executableOwner = Boolean(opts.owner && /^(function|method|constructor|variable)$/.test(opts.owner.kind));
  const testOwner = Boolean(opts.owner && /(^|\.)test[_A-Z]|^test/i.test(opts.owner.name));
  return (
    (opts.pathHint && (opts.file === opts.pathHint || opts.file.endsWith(`/${opts.pathHint}`)) ? 1000 : 0) +
    searchRoleScore(opts.file, opts.request.kind) +
    (exactLiteral ? 60 : 0) +
    (executableOwner ? 30 : 0) +
    (opts.request.kind === "test" && testOwner ? 50 : 0)
  );
}

export function candidateAnchorIssue(candidate: CandidateFinding, scope: ReviewScope): string | undefined {
  if (!scope.changedFiles.includes(candidate.file)) return "finding location is outside the changed review scope";
  const content = scope.fileContents[candidate.file];
  if (content === undefined) return "changed file content is unavailable";
  if (candidate.line < 1 || candidate.line > content.split("\n").length)
    return "finding line is outside the changed file";
  const exactRanges = parseAddedLineRanges(scope.diff).filter((range) => range.file === candidate.file);
  const ranges = exactRanges.length ? exactRanges : changedRanges(scope.diff).filter((range) => range.file === candidate.file);
  if (
    ranges.length &&
    !ranges.some((range) => candidate.line <= range.end && (candidate.endLine ?? candidate.line) >= range.start)
  )
    return exactRanges.length
      ? "finding does not overlap an added or replaced line"
      : "finding does not overlap a changed hunk";
  return undefined;
}

export function resolveEvidenceRequests(opts: {
  candidate: CandidateFinding;
  scope: ReviewScope;
  graph: GraphContext;
  policy: EvidencePolicy;
}): { records: EvidenceRecord[]; gaps: string[]; outcomes: EvidenceResolutionOutcome[] } {
  const records: EvidenceRecord[] = [];
  const gaps: string[] = [];
  const outcomes: EvidenceResolutionOutcome[] = [];
  const symbols = opts.graph.nodes.map((node) => node.symbol).filter((symbol) => symbolMatchesSnapshot(opts.scope, symbol));
  const maxPerRequest = opts.policy.maxRecordsPerRequest ?? 3;
  const maxPerCandidate = opts.policy.maxRecordsPerCandidate ?? 8;
  const requests = [
    ...new Map(
      opts.candidate.evidenceRequests.map((request) => [
        `${request.kind}:${request.locatorMode ?? ""}:${request.symbol ?? ""}:${request.pathHint ?? ""}:${request.query ?? ""}`,
        request,
      ]),
    ).values(),
  ].slice(0, opts.policy.maxRequestsPerCandidate);
  for (const [requestIndex, request] of requests.entries()) {
    const requestId = evidenceRequestId(request);
    const remainingRequestGroups = requests.length - requestIndex - 1;
    const requestRecordLimit = Math.min(
      maxPerRequest,
      Math.max(0, maxPerCandidate - records.length - remainingRequestGroups),
    );
    if (requestRecordLimit < 1) {
      const reason = "candidate evidence record limit reached";
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    const requestRecords: EvidenceRecord[] = [];
    let resolverRoute: EvidenceResolutionOutcome["resolverRoute"];
    let consideredRecords = 0;
    const locator = evidenceLocatorParts(request);
    const literalMode = request.locatorMode === "literal";
    if (!literalMode && request.symbol && !locator.symbolLocatorValid) {
      const reason = "invalid expression-shaped symbol locator; use a canonical symbol or literal mode";
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    const matchedSymbols = literalMode
      ? []
      : symbols.filter((symbol) => {
          const symbolFile = normalizedRepositoryPath(symbol.file);
          if (locator.pathHint && symbolFile !== locator.pathHint && !symbolFile.endsWith(`/${locator.pathHint}`))
            return false;
          if (
            request.symbol &&
            !locator.symbolCandidates.some(
              (candidate) =>
                symbol.name === candidate ||
                symbol.qualifiedName === candidate ||
                symbol.qualifiedName.endsWith(`.${candidate}`),
            )
          )
            return false;
          return Boolean(request.symbol || locator.pathHint);
        });
    const matchedFiles = new Set(matchedSymbols.map((symbol) => normalizedRepositoryPath(symbol.file)));
    if (!literalMode && request.symbol && matchedSymbols.length === 0) {
      const reason = "canonical symbol locator was not found in the frozen graph snapshot";
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    if (!locator.pathHint && matchedFiles.size > 1) {
      const reason = `ambiguous locator matched ${matchedFiles.size} files: ${[...matchedFiles].sort().join(", ")}`;
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    const selectedSymbols = new Map<string, (typeof symbols)[number]>();
    const strictRelation = request.kind === "callers" || request.kind === "callees";
    if (["callers", "callees", "usage"].includes(request.kind)) {
      const matchedKeys = new Set(matchedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`));
      for (const edge of opts.graph.edges) {
        if ((request.kind === "callers" || request.kind === "callees") && edge.kind !== "calls") continue;
        const relatedKeys =
          request.kind === "callees"
            ? matchedKeys.has(edge.source) && edge.target
              ? [edge.target]
              : []
            : request.kind === "callers"
              ? edge.target && matchedKeys.has(edge.target)
                ? [edge.source]
                : []
              : [
                  ...(matchedKeys.has(edge.source) && edge.target ? [edge.target] : []),
                  ...(edge.target && matchedKeys.has(edge.target) ? [edge.source] : []),
                ];
        for (const key of relatedKeys) {
          const related = symbols.find((symbol) => `${symbol.file}:${symbol.qualifiedName}` === key);
          if (related) selectedSymbols.set(key, related);
        }
      }
    } else {
      for (const symbol of matchedSymbols) selectedSymbols.set(`${symbol.file}:${symbol.qualifiedName}`, symbol);
    }
    for (const symbol of [...selectedSymbols.values()].slice(0, requestRecordLimit)) {
      const lines = readLines(opts.scope, symbol.file);
      if (!lines.length) continue;
      const symbolStart = Math.max(1, symbol.startLine);
      const symbolEnd = Math.min(lines.length, symbol.endLine);
      const locatorName = locator.symbolCandidates.at(-1);
      const matchedLine = locatorName
        ? lines.findIndex((line, index) => index + 1 >= symbolStart && index + 1 <= symbolEnd && line.includes(locatorName)) + 1
        : 0;
      const center = matchedLine >= symbolStart ? matchedLine : symbolStart;
      const snippetLines = Math.min(48, opts.policy.maxSnippetLines);
      const start = Math.max(symbolStart, center - 12);
      const end = Math.min(symbolEnd, start + snippetLines - 1);
      requestRecords.push(
        record(
          requestId,
          request,
          symbol.file,
          start,
          lines.slice(start - 1, end),
          symbol.qualifiedName,
          request.kind,
          locator.symbolCandidates[0],
        ),
      );
      resolverRoute = "graph-symbol";
      if (records.length + requestRecords.length >= maxPerCandidate || requestRecords.length >= requestRecordLimit) break;
    }
    const fallbackPath = locator.pathHint ?? opts.candidate.file;
    if (!strictRelation && !literalMode && !requestRecords.length && fallbackPath && records.length < maxPerCandidate) {
      const resolved = safePath(opts.scope.root, fallbackPath);
      const lines = resolved ? readLines(opts.scope, resolved.relative) : [];
      if (resolved && lines.length) {
        const query = locator.textQueries.find((candidate) => lines.some((line) => line.includes(candidate)));
        const index = query ? lines.findIndex((line) => line.includes(query)) : -1;
        if (index >= 0) {
          const startIndex = Math.max(0, index - 12);
          requestRecords.push(
            record(
              requestId,
              request,
              resolved.relative,
              startIndex + 1,
              lines.slice(startIndex, startIndex + opts.policy.maxSnippetLines),
              locator.symbolCandidates.at(-1) ?? request.symbol,
              request.kind,
              query,
            ),
          );
          resolverRoute = "path-search";
        }
      }
    }
    if (
      !literalMode &&
      !requestRecords.length &&
      ["search", "config", "test", "schema"].includes(request.kind) &&
      request.query &&
      request.query.length >= 3 &&
      request.query.length <= 200 &&
      records.length < maxPerCandidate
    ) {
      for (const file of [...new Set([...opts.scope.changedFiles, ...symbols.map((symbol) => symbol.file)])].sort()) {
        const lines = readLines(opts.scope, file);
        const index = lines.findIndex((line) => line.includes(request.query!));
        if (index < 0) continue;
        const startIndex = Math.max(0, index - 8);
        requestRecords.push(
          record(
            requestId,
            request,
            file,
            startIndex + 1,
            lines.slice(startIndex, startIndex + Math.min(40, opts.policy.maxSnippetLines)),
            undefined,
            "literal-search",
            request.query,
          ),
        );
        resolverRoute = "path-search";
          if (records.length + requestRecords.length >= maxPerCandidate || requestRecords.length >= requestRecordLimit) break;
      }
    }
    if (!strictRelation && !requestRecords.length) {
      const query =
        request.query?.trim() ||
        locator.textQueries.find((value) => value.length >= 3) ||
        locator.symbolCandidates.at(-1)?.trim();
      if (query && query.length >= 3 && query.length <= 200) {
        const hits: Array<{ file: string; index: number; score: number; owner?: string }> = [];
        for (const file of evidenceSearchFiles(opts.scope)) {
          const lines = readLines(opts.scope, file);
          for (let index = 0; index < lines.length; index++) {
            if (!lines[index].includes(query)) continue;
            const graphOwner = enclosingSymbol(symbols, file, index + 1);
            const owner = graphOwner ?? lexicalOwner(lines, index);
            hits.push({
              file,
              index,
              score: literalHitScore({
                file,
                line: lines[index],
                query,
                request,
                pathHint: locator.pathHint,
                owner,
              }),
              owner: graphOwner?.qualifiedName ?? owner?.name,
            });
          }
        }
        consideredRecords = hits.length;
        hits.sort(
          (left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.index - right.index,
        );
        for (const hit of hits) {
          const lines = readLines(opts.scope, hit.file);
          const index = hit.index;
          const startIndex = Math.max(0, index - (literalMode ? 8 : request.kind === "test" ? 8 : 12));
          requestRecords.push(
            record(
              requestId,
              request,
              hit.file,
              startIndex + 1,
              lines.slice(startIndex, startIndex + Math.min(literalMode ? 24 : 60, opts.policy.maxSnippetLines)),
              hit.owner ?? request.symbol,
              "repository-search",
              query,
            ),
          );
          resolverRoute = "repository-literal";
          if (
            records.length + requestRecords.length >= maxPerCandidate ||
            requestRecords.length >= (literalMode ? 1 : requestRecordLimit)
          )
            break;
        }
      }
    }
    if (requestRecords.length) {
      records.push(...requestRecords);
      outcomes.push({
        requestId,
        request,
        status: "satisfied",
        records: requestRecords,
        resolverRoute,
        consideredRecords,
      });
    } else {
      const reason = `no exact evidence matched: ${request.reason}`;
      gaps.push(`${request.kind}: ${reason}`);
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
    }
  }
  return { records: [...new Map(records.map((item) => [item.id, item])).values()], gaps, outcomes };
}
