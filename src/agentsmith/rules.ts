import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";
import type { ReviewWorkItem, RenderedRule, StructuredReviewRule } from "./engine-types.js";
import type { ReviewProjection } from "./engine-types.js";

const ruleSchema = z.object({
  id: z.string().min(1),
  languages: z.array(z.string()).min(1),
  categories: z.array(z.enum(["correctness", "security", "performance", "contract"])).min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  triggers: z
    .array(
      z.object({
        languages: z.array(z.string()).optional(),
        categories: z.array(z.enum(["correctness", "security", "performance", "contract"])).optional(),
        paths: z.array(z.string()).optional(),
        symbolKinds: z.array(z.string()).optional(),
        edgeKinds: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  short: z.string().min(1),
  explanation: z.string().min(1),
  examples: z.array(z.object({ bad: z.string(), good: z.string().optional() })).optional(),
});

function registryPath(assetRoot?: string) {
  if (assetRoot) {
    const candidate = path.join(assetRoot, "rules", "registry.yaml");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "rules", "registry.yaml");
}

export function loadStructuredRules(assetRoot?: string): StructuredReviewRule[] {
  return z
    .array(ruleSchema)
    .parse(yaml.load(fs.readFileSync(registryPath(assetRoot), "utf8"))) as StructuredReviewRule[];
}

function matches(
  rule: StructuredReviewRule,
  input: { languages: string[]; text: string; edges: string[]; paths: string[] },
) {
  if (!rule.languages.some((language) => input.languages.includes(language))) return false;
  if (!rule.triggers.length) return true;
  const lower = input.text.toLowerCase();
  return rule.triggers.some(
    (trigger) =>
      (!trigger.languages || trigger.languages.some((language) => input.languages.includes(language))) &&
      (!trigger.edgeKinds || trigger.edgeKinds.some((edge) => input.edges.includes(edge))) &&
      (!trigger.paths || trigger.paths.some((fragment) => input.paths.some((file) => file.includes(fragment)))) &&
      (!trigger.keywords || trigger.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))),
  );
}

/** Prefer edge-relevant families when a calls interaction falls back from witnesses. */
export function callsInteractionRulePriority(ruleId: string): number {
  const id = ruleId.toLowerCase();
  if (id.includes("producer-consumer") || id.includes("value-provenance")) return 100;
  // Prefer performance over lifecycle when both match so call-boundary resource
  // accumulation classifies under the performance family when applicable.
  if (id.includes("performance")) return 95;
  if (id.includes("lifecycle")) return 85;
  if (id.includes("control-flow") || id.includes("interface-implementation")) return 70;
  if (id.includes("configuration") || id.includes("nullability")) return 20;
  return 50;
}

/** Prefer label/value-preservation families for reads-type interaction fallback. */
export function readsTypeInteractionRulePriority(ruleId: string): number {
  const id = ruleId.toLowerCase();
  if (id.includes("value-provenance")) return 100;
  if (id.includes("interface-implementation")) return 90;
  if (id.includes("producer-consumer")) return 70;
  if (id.includes("control-flow") || id.includes("nullability")) return 40;
  if (id.includes("configuration") || id.includes("performance") || id.includes("lifecycle")) return 20;
  return 50;
}

const CALLS_WITNESS_FALLBACK_FAMILY_FRAGMENTS = [
  "producer-consumer",
  "value-provenance",
  "performance",
  "lifecycle",
  "control-flow",
  "interface-implementation",
] as const;

const READS_TYPE_WITNESS_FALLBACK_FAMILY_FRAGMENTS = [
  "value-provenance",
  "interface-implementation",
  "producer-consumer",
  "control-flow",
  "nullability",
] as const;

export function isCallsWitnessFallbackRule(ruleId: string): boolean {
  const id = ruleId.toLowerCase();
  return CALLS_WITNESS_FALLBACK_FAMILY_FRAGMENTS.some((fragment) => id.includes(fragment));
}

export function isReadsTypeWitnessFallbackRule(ruleId: string): boolean {
  const id = ruleId.toLowerCase();
  return READS_TYPE_WITNESS_FALLBACK_FAMILY_FRAGMENTS.some((fragment) => id.includes(fragment));
}

export function prioritizeRulesForCallsInteraction<T extends { id: string }>(rules: T[]): T[] {
  return [...rules].sort(
    (left, right) =>
      callsInteractionRulePriority(right.id) - callsInteractionRulePriority(left.id) ||
      left.id.localeCompare(right.id),
  );
}

export function prioritizeRulesForReadsTypeInteraction<T extends { id: string }>(rules: T[]): T[] {
  return [...rules].sort(
    (left, right) =>
      readsTypeInteractionRulePriority(right.id) - readsTypeInteractionRulePriority(left.id) ||
      left.id.localeCompare(right.id),
  );
}

/** On witness→rule-bound fallback for calls edges, keep only edge-relevant families. */
export function filterRulesForCallsWitnessFallback<T extends { id: string }>(rules: T[]): T[] {
  let filtered = rules.filter((rule) => isCallsWitnessFallbackRule(rule.id));
  if (!filtered.length) filtered = [...rules];
  // When performance is in scope, drop lifecycle so accumulating call-boundary
  // work classifies under performance rather than a competing lifecycle rule.
  if (filtered.some((rule) => rule.id.toLowerCase().includes("performance"))) {
    filtered = filtered.filter((rule) => !rule.id.toLowerCase().includes("lifecycle"));
  }
  return prioritizeRulesForCallsInteraction(filtered).slice(0, 3);
}

/** On witness→rule-bound fallback for reads-type edges, prefer value-provenance/labels. */
export function filterRulesForReadsTypeWitnessFallback<T extends { id: string }>(rules: T[]): T[] {
  const filtered = rules.filter((rule) => isReadsTypeWitnessFallbackRule(rule.id));
  return prioritizeRulesForReadsTypeInteraction(filtered.length ? filtered : rules).slice(0, 3);
}

export function selectRules(
  rules: StructuredReviewRule[],
  input: Pick<ReviewProjection, "metadata" | "code" | "graphEdges"> | ReviewWorkItem,
  limit = Number.POSITIVE_INFINITY,
  verbose = false,
): RenderedRule[] {
  const code = input.code.map((snippet) => snippet.content).join("\n");
  const edges = input.graphEdges.map((edge) => edge.kind);
  const paths = input.code.map((snippet) => snippet.file);
  const languages =
    "metadata" in input
      ? input.metadata.languages
      : [
          ...new Set(
            input.code.map((snippet) => {
              const extension = path.extname(snippet.file);
              if (/\.(ts|tsx|js|jsx)$/.test(extension)) return "typescript";
              if (/\.(py|pyi)$/.test(extension)) return "python";
              return extension.slice(1);
            }),
          ),
        ];
  const callsInteraction =
    !("metadata" in input) &&
    input.kind === "interaction" &&
    input.graphEdges.some((edge) => edge.kind === "calls");
  const readsTypeInteraction =
    !("metadata" in input) &&
    input.kind === "interaction" &&
    input.graphEdges.some((edge) => edge.kind === "reads-type");
  return rules
    .filter((rule) => matches(rule, { languages, text: code, edges, paths }))
    // A declared severity is policy metadata, not a model-generated risk score.
    // Preserve these rules under a bounded rule cap so a task can see the
    // applicable policy that owns its classification.
    .sort((left, right) => {
      const severityRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
      const leftRank = left.severity ? severityRank[left.severity] : 0;
      const rightRank = right.severity ? severityRank[right.severity] : 0;
      const edgeBias = callsInteraction
        ? callsInteractionRulePriority(right.id) - callsInteractionRulePriority(left.id)
        : readsTypeInteraction
          ? readsTypeInteractionRulePriority(right.id) - readsTypeInteractionRulePriority(left.id)
          : 0;
      // Severity remains primary; edge bias only reorders within the same severity band.
      return rightRank - leftRank || edgeBias || left.id.localeCompare(right.id);
    })
    .slice(0, limit)
    .map((rule) => {
      const text = verbose ? `${rule.short}\n${rule.explanation}` : rule.short;
      return {
        id: rule.id,
        text,
        estimatedTokens: Math.ceil(text.length / 3),
        categories: [...rule.categories],
        ...(rule.severity ? { severity: rule.severity } : {}),
      };
    });
}
