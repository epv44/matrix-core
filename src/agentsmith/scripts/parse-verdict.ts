import yaml from "js-yaml";
import { z } from "zod";

export type LegacyReviewFindingDomain = "architecture" | "performance" | "correctness" | "semantics";
export interface LegacyReviewFinding {
  id?: string;
  severity: "info" | "warn" | "blocker";
  message: string;
  file?: string;
  line?: number;
  col?: number;
  ruleId?: string;
  domain?: LegacyReviewFindingDomain;
  evidence?: string;
  impact?: string;
  recommendation?: string;
  reporters?: string[];
}

export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "RISK";

export interface ParsedVerdict {
  verdict: Verdict;
  summary: string;
  findings: LegacyReviewFinding[];
}

const VERDICTS: Verdict[] = ["APPROVE", "REQUEST_CHANGES", "RISK"];
const DOMAINS: LegacyReviewFindingDomain[] = ["architecture", "performance", "correctness", "semantics"];

function extractStructured(raw: string): string {
  if (raw.length > 256_000) throw new Error("AgentSmith response exceeds 256000 characters");
  const fenced = /```(?:json|ya?ml)?\s*\n?([\s\S]*?)```/i.exec(raw);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

function normalizeSeverity(value: unknown): LegacyReviewFinding["severity"] {
  const severity = String(value ?? "warn").toLowerCase();
  if (["critical", "blocker", "error", "high"].includes(severity)) return "blocker";
  if (["info", "minor", "note", "low", "nit"].includes(severity)) return "info";
  return "warn";
}

export function parseVerdict(raw: string): ParsedVerdict {
  let data: any;
  try {
    const structured = extractStructured(raw);
    data = structured.trimStart().startsWith("{") ? JSON.parse(structured) : yaml.load(structured);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a mapping");
  } catch {
    throw new Error("AgentSmith parse-verdict: no JSON object or YAML mapping found in provider output");
  }
  const schema = z.object({
    verdict: z.string().optional(),
    summary: z.string().optional(),
    findings: z
      .array(
        z.object({
          severity: z.unknown().optional(),
          message: z.unknown().optional(),
          file: z.string().optional(),
          line: z.number().int().positive().optional(),
          col: z.number().int().positive().optional(),
          ruleId: z.string().optional(),
          domain: z.string().optional(),
          evidence: z.string().optional(),
          impact: z.string().optional(),
          recommendation: z.string().optional(),
        }),
      )
      .default([]),
  });
  const validated = schema.safeParse(data);
  if (!validated.success) throw new Error(`AgentSmith verdict schema invalid: ${validated.error.message}`);
  data = validated.data;
  const verdictRaw = String(data?.verdict ?? "").toUpperCase();
  const verdict: Verdict = VERDICTS.includes(verdictRaw as Verdict) ? (verdictRaw as Verdict) : "REQUEST_CHANGES";
  const findings: LegacyReviewFinding[] = Array.isArray(data?.findings)
    ? data.findings.map((finding: any, index: number) => ({
        severity: normalizeSeverity(finding?.severity),
        message: String(finding?.message ?? `finding ${index + 1}`),
        file: typeof finding?.file === "string" ? finding.file : undefined,
        line: typeof finding?.line === "number" ? finding.line : undefined,
        col: typeof finding?.col === "number" ? finding.col : undefined,
        ruleId: typeof finding?.ruleId === "string" ? finding.ruleId : undefined,
        domain: DOMAINS.includes(finding?.domain as LegacyReviewFindingDomain)
          ? (finding.domain as LegacyReviewFindingDomain)
          : undefined,
        evidence: typeof finding?.evidence === "string" ? finding.evidence : undefined,
        impact: typeof finding?.impact === "string" ? finding.impact : undefined,
        recommendation: typeof finding?.recommendation === "string" ? finding.recommendation : undefined,
      }))
    : [];
  return {
    verdict: verdict === "APPROVE" && findings.length > 0 ? "RISK" : verdict,
    summary: typeof data?.summary === "string" ? data.summary : "",
    findings,
  };
}

export function verdictToStatus(verdict: Verdict): "PASS" | "FAIL" {
  return verdict === "APPROVE" ? "PASS" : "FAIL";
}
