import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CandidateFinding, EvidencePolicy, EvidenceRecord, EvidenceRequest } from "../core/types.js";
import type { GraphContext } from "../core/graph/types.js";
import type { ReviewScope } from "./scope.js";
import { changedRanges } from "./projection.js";

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

function record(
  request: EvidenceRequest,
  file: string,
  startLine: number,
  lines: string[],
  symbol?: string,
  relation?: string,
): EvidenceRecord {
  const snippet = lines.join("\n");
  const id = crypto
    .createHash("sha256")
    .update(JSON.stringify({ file, startLine, snippet, symbol }))
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    requestKind: request.kind,
    file,
    startLine,
    endLine: startLine + lines.length - 1,
    symbol,
    snippet,
    relation,
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
}): { records: EvidenceRecord[]; gaps: string[] } {
  const records: EvidenceRecord[] = [];
  const gaps: string[] = [];
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
    if (records.length >= maxPerCandidate) break;
    let matched = false;
    let requestRecords = 0;
    const locator = evidenceLocatorParts(request);
    const selectedSymbols = symbols.filter((symbol) => {
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
      if (["callers", "callees", "usage"].includes(request.kind)) {
        const key = `${symbol.file}:${symbol.qualifiedName}`;
        return opts.graph.edges.some(
          (edge) =>
            edge.source === key ||
            edge.target === key ||
            locator.symbolCandidates.some((candidate) => edge.targetText === candidate),
        );
      }
      return Boolean(request.symbol || locator.pathHint);
    });
    for (const symbol of selectedSymbols.slice(0, maxPerRequest)) {
      const lines = readLines(opts.scope, symbol.file);
      if (!lines.length) continue;
      const start = Math.max(1, symbol.startLine);
      const end = Math.min(lines.length, symbol.endLine, start + opts.policy.maxSnippetLines - 1);
      records.push(
        record(request, symbol.file, start, lines.slice(start - 1, end), symbol.qualifiedName, request.kind),
      );
      matched = true;
      requestRecords += 1;
      if (records.length >= maxPerCandidate || requestRecords >= maxPerRequest) break;
    }
    const fallbackPath = locator.pathHint ?? opts.candidate.file;
    if (!matched && fallbackPath && records.length < maxPerCandidate) {
      const resolved = safePath(opts.scope.root, fallbackPath);
      const lines = resolved ? readLines(opts.scope, resolved.relative) : [];
      if (resolved && lines.length) {
        const query = locator.textQueries.find((candidate) => lines.some((line) => line.includes(candidate)));
        const candidateFile = normalizedRepositoryPath(opts.candidate.file);
        const index = query
          ? lines.findIndex((line) => line.includes(query))
          : resolved.relative === candidateFile
            ? Math.max(0, Math.min(lines.length - 1, opts.candidate.line - 1))
            : -1;
        if (index >= 0) {
          const startIndex = Math.max(0, index - 12);
          records.push(
            record(
              request,
              resolved.relative,
              startIndex + 1,
              lines.slice(startIndex, startIndex + opts.policy.maxSnippetLines),
              locator.symbolCandidates.at(-1) ?? request.symbol,
              request.kind,
            ),
          );
          matched = true;
          requestRecords += 1;
        }
      }
    }
    if (
      !matched &&
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
        records.push(
          record(
            request,
            file,
            startIndex + 1,
            lines.slice(startIndex, startIndex + Math.min(40, opts.policy.maxSnippetLines)),
            undefined,
            "literal-search",
          ),
        );
        matched = true;
        requestRecords += 1;
        if (records.length >= maxPerCandidate || requestRecords >= maxPerRequest) break;
      }
    }
    if (!matched) gaps.push(`${request.kind}: ${request.reason}`);
  }
  return { records: [...new Map(records.map((item) => [item.id, item])).values()], gaps };
}
