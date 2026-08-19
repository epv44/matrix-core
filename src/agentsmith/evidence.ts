import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CandidateFinding, EvidencePolicy, EvidenceRecord, EvidenceRequest } from "../core/types.js";
import type { GraphContext } from "../core/graph/types.js";
import type { ReviewScope } from "./scope.js";
import { changedRanges } from "./projection.js";

const REVIEWER_DOMAINS = {
  "architecture-reviewer": "architecture",
  "perf-reviewer": "performance",
  "bug-hunter": "correctness",
  "semantic-reviewer": "semantics",
} as const;

/** Retained only for reading pre-v2 assets and traces. */
export function reviewerDomain(reviewer: string): string {
  const domain = REVIEWER_DOMAINS[reviewer as keyof typeof REVIEWER_DOMAINS];
  if (!domain) throw new Error(`Unknown AgentSmith reviewer: ${reviewer}`);
  return domain;
}

function safePath(root: string, value: string) {
  const relative = path.normalize(value).replaceAll("\\", "/").replace(/^\.\//, "");
  const absolute = path.resolve(root, relative);
  return absolute === root || absolute.startsWith(root + path.sep) ? { relative, absolute } : undefined;
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
    .update(JSON.stringify({ request, file, startLine, snippet, symbol, relation }))
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
  for (const request of opts.candidate.evidenceRequests.slice(0, opts.policy.maxRequestsPerCandidate)) {
    let matched = false;
    const selectedSymbols = symbols.filter((symbol) => {
      if (request.pathHint && symbol.file !== request.pathHint && !symbol.file.includes(request.pathHint)) return false;
      if (request.symbol && symbol.name !== request.symbol && symbol.qualifiedName !== request.symbol) return false;
      if (["callers", "callees", "usage"].includes(request.kind)) {
        const key = `${symbol.file}:${symbol.qualifiedName}`;
        return opts.graph.edges.some(
          (edge) => edge.source === key || edge.target === key || edge.targetText === request.symbol,
        );
      }
      return Boolean(request.symbol || request.pathHint);
    });
    for (const symbol of selectedSymbols.slice(0, 8)) {
      const lines = readLines(opts.scope, symbol.file);
      if (!lines.length) continue;
      const start = Math.max(1, symbol.startLine);
      const end = Math.min(lines.length, symbol.endLine, start + opts.policy.maxSnippetLines - 1);
      records.push(
        record(request, symbol.file, start, lines.slice(start - 1, end), symbol.qualifiedName, request.kind),
      );
      matched = true;
    }
    if (!matched && request.pathHint) {
      const resolved = safePath(opts.scope.root, request.pathHint);
      const lines = resolved ? readLines(opts.scope, resolved.relative) : [];
      if (resolved && lines.length) {
        const query = request.query ?? request.symbol;
        const index = query ? lines.findIndex((line) => line.includes(query)) : 0;
        if (index >= 0) {
          const startIndex = Math.max(0, index - 12);
          records.push(
            record(
              request,
              resolved.relative,
              startIndex + 1,
              lines.slice(startIndex, startIndex + opts.policy.maxSnippetLines),
              request.symbol,
              request.kind,
            ),
          );
          matched = true;
        }
      }
    }
    if (
      !matched &&
      request.kind === "search" &&
      request.query &&
      request.query.length >= 3 &&
      request.query.length <= 200
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
        if (records.length >= 8) break;
      }
    }
    if (!matched) gaps.push(`${request.kind}: ${request.reason}`);
  }
  return { records: [...new Map(records.map((item) => [item.id, item])).values()], gaps };
}

/** Pre-v2 compatibility helper for old trace readers; v2 verification does not use it. */
export function classifyFindingEvidence<T extends Record<string, any>>(
  finding: T,
  scope?: ReviewScope,
  expectedDomain?: string,
): T {
  const issues: string[] = [];
  const file =
    typeof finding.file === "string"
      ? path.normalize(finding.file).replaceAll("\\", "/").replace(/^\.\//, "")
      : undefined;
  const content = file && scope?.changedFiles.includes(file) ? scope.fileContents[file] : undefined;
  if (!file) issues.push("missing file");
  else if (!scope) issues.push("review scope unavailable");
  else if (content === undefined) issues.push("file is outside the changed review scope");
  if (!finding.line) issues.push("missing line");
  else if (content !== undefined) {
    const lines = content.split("\n");
    if (finding.line > lines.length) issues.push(`line ${finding.line} is outside the file`);
    else if (!String(finding.evidence ?? "").trim()) issues.push("missing evidence excerpt");
    else {
      const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
      const nearby = normalized(
        lines.slice(Math.max(0, finding.line - 4), Math.min(lines.length, finding.line + 3)).join("\n"),
      );
      if (!nearby.includes(normalized(String(finding.evidence))))
        issues.push("evidence excerpt does not match the claimed location");
    }
  }
  if (!String(finding.impact ?? "").trim()) issues.push("missing impact");
  if (!String(finding.recommendation ?? "").trim()) issues.push("missing recommendation");
  if (expectedDomain && finding.domain !== expectedDomain)
    issues.push(
      finding.domain
        ? `reviewer domain ${finding.domain} does not match expected ${expectedDomain}`
        : `missing reviewer domain (expected ${expectedDomain})`,
    );
  return { ...finding, file, evidenceStatus: issues.length ? "unverified" : "located", validationIssues: issues };
}
export function classifyFindingEvidenceList<T extends Record<string, any>>(
  findings: T[],
  scope?: ReviewScope,
  expectedDomain?: string,
): T[] {
  return findings.map((finding) => classifyFindingEvidence(finding, scope, expectedDomain));
}
