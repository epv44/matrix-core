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
import { sha256Json } from "../core/hash.js";

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
  const beforeCall = beforeDescription.replace(/\(.*$/, "").trim();
  const identifiers = beforeCall.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const symbolCandidates = [locator, beforeDescription, beforeCall, identifiers.at(-1) ?? ""]
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && !value.startsWith("{") && !value.includes(" "));
  const textQueries = [locator, beforeDescription, beforeCall, identifiers.at(-1) ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && value.length <= 200);
  return {
    pathHint: pathHint ? normalizedRepositoryPath(pathHint) : undefined,
    symbolCandidates: [...new Set(symbolCandidates)],
    textQueries: [...new Set(textQueries)],
  };
}

export function evidenceRequestId(request: EvidenceRequest): string {
  return sha256Json(
    { kind: request.kind, symbol: request.symbol ?? "", pathHint: request.pathHint ?? "", query: request.query ?? "" },
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

export function candidateAnchorIssue(candidate: CandidateFinding, scope: ReviewScope): string | undefined {
  if (!scope.changedFiles.includes(candidate.file)) return "finding location is outside the changed review scope";
  const content = scope.fileContents[candidate.file];
  if (content === undefined) return "changed file content is unavailable";
  if (candidate.line < 1 || candidate.line > content.split("\n").length)
    return "finding line is outside the changed file";
  const ranges = changedRanges(scope.diff).filter((range) => range.file === candidate.file);
  if (
    ranges.length &&
    !ranges.some((range) => candidate.line <= range.end && (candidate.endLine ?? candidate.line) >= range.start)
  )
    return "finding does not overlap a changed hunk";
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
  const symbols = opts.graph.nodes.map((node) => node.symbol);
  const maxPerRequest = opts.policy.maxRecordsPerRequest ?? 3;
  const maxPerCandidate = opts.policy.maxRecordsPerCandidate ?? 8;
  const requests = [
    ...new Map(
      opts.candidate.evidenceRequests.map((request) => [
        `${request.kind}:${request.symbol ?? ""}:${request.pathHint ?? ""}:${request.query ?? ""}`,
        request,
      ]),
    ).values(),
  ].slice(0, opts.policy.maxRequestsPerCandidate);
  for (const request of requests) {
    const requestId = evidenceRequestId(request);
    if (records.length >= maxPerCandidate) {
      const reason = "candidate evidence record limit reached";
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    const requestRecords: EvidenceRecord[] = [];
    const locator = evidenceLocatorParts(request);
    const matchedSymbols = symbols.filter((symbol) => {
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
    if (!locator.pathHint && matchedFiles.size > 1) {
      const reason = `ambiguous locator matched ${matchedFiles.size} files: ${[...matchedFiles].sort().join(", ")}`;
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
      gaps.push(`${request.kind}: ${reason}`);
      continue;
    }
    const selectedSymbols = new Map<string, (typeof symbols)[number]>();
    if (["callers", "callees", "usage"].includes(request.kind)) {
      const matchedKeys = new Set(matchedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`));
      for (const edge of opts.graph.edges) {
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
    for (const symbol of [...selectedSymbols.values()].slice(0, maxPerRequest)) {
      const lines = readLines(opts.scope, symbol.file);
      if (!lines.length) continue;
      const start = Math.max(1, symbol.startLine);
      const end = Math.min(lines.length, symbol.endLine, start + opts.policy.maxSnippetLines - 1);
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
      if (records.length + requestRecords.length >= maxPerCandidate || requestRecords.length >= maxPerRequest) break;
    }
    const fallbackPath = locator.pathHint ?? opts.candidate.file;
    if (!requestRecords.length && fallbackPath && records.length < maxPerCandidate) {
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
        }
      }
    }
    if (
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
        if (records.length + requestRecords.length >= maxPerCandidate || requestRecords.length >= maxPerRequest) break;
      }
    }
    if (requestRecords.length) {
      records.push(...requestRecords);
      outcomes.push({ requestId, request, status: "satisfied", records: requestRecords });
    } else {
      const reason = `no exact evidence matched: ${request.reason}`;
      gaps.push(`${request.kind}: ${reason}`);
      outcomes.push({ requestId, request, status: "unresolved", records: [], reason });
    }
  }
  return { records: [...new Map(records.map((item) => [item.id, item])).values()], gaps, outcomes };
}
