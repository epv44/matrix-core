import { verdictToStatus, type LegacyReviewFinding, type ParsedVerdict } from "./parse-verdict.js";
import crypto from "node:crypto";
import path from "node:path";

const SEVERITY_RANK: Record<LegacyReviewFinding["severity"], number> = { blocker: 3, warn: 2, info: 1 };
function findingKey(finding: LegacyReviewFinding) {
  return `${finding.file ?? ""}:${finding.line ?? ""}:${finding.ruleId ?? ""}:${finding.message.trim().toLowerCase()}`;
}

export function aggregateFindings(verdicts: ParsedVerdict[]): {
  status: "PASS" | "FAIL";
  findings: LegacyReviewFinding[];
} {
  const seen = new Set<string>();
  const findings: LegacyReviewFinding[] = [];
  for (const verdict of verdicts) {
    for (const finding of verdict.findings) {
      const normalized = {
        ...finding,
        file: finding.file ? path.normalize(finding.file).replaceAll("\\", "/").replace(/^\.\//, "") : undefined,
      };
      const key = findingKey(normalized);
      if (seen.has(key)) {
        const existing = findings.find((item) => findingKey(item) === key);
        if (existing) existing.reporters = [...new Set([...(existing.reporters ?? []), ...(finding.reporters ?? [])])];
        continue;
      }
      seen.add(key);
      findings.push({ ...normalized, id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16) });
    }
  }
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const status: "PASS" | "FAIL" =
    findings.length > 0 || verdicts.some((verdict) => verdictToStatus(verdict.verdict) === "FAIL") ? "FAIL" : "PASS";
  return { status, findings };
}
