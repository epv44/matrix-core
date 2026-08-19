import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "./config-resolver.js";
import { computeWorkspaceVersion } from "./version.js";
import { readReviewResult } from "../agentsmith/review-store.js";
import type { FixRequest, FixTask } from "./types.js";

export function prepareFix(request: FixRequest): FixTask {
  const root = resolveConfig({ cwd: request.cwd }).configRoot;
  const review = readReviewResult(root);
  const errors: string[] = [];
  const base: Omit<FixTask, "status"> = {
    schemaVersion: 1,
    reviewVersion: request.reviewVersion,
    findingIds: request.findingIds,
    findings: [],
    context: {},
    instructions: [],
    verification: { changed: "quality run --changed --fast", review: "quality review", full: "quality run --full" },
    errors,
  };
  if (!review) return { ...base, status: "INVALID", errors: ["No AgentSmith review result found"] };
  if (
    review.version !== request.reviewVersion ||
    computeWorkspaceVersion(root) !== request.reviewVersion ||
    review.status === "stale"
  )
    return {
      ...base,
      status: "STALE",
      errors: ["The workspace no longer matches the selected review; run quality review again"],
    };
  const requested = new Set(request.findingIds);
  const findings = review.findings.filter((finding) => finding.id && requested.has(finding.id));
  const found = new Set(findings.map((finding) => finding.id!));
  for (const id of requested) if (!found.has(id)) errors.push(`Unknown or unpublished finding ID: ${id}`);
  if (request.findingIds.length === 0) errors.push("At least one finding ID is required");
  const context: Record<string, string> = {};
  for (const finding of findings)
    if (finding.file) {
      const absolute = path.resolve(root, finding.file);
      if (absolute !== root && !absolute.startsWith(root + path.sep))
        errors.push(`Finding path escapes workspace: ${finding.file}`);
      else
        try {
          context[finding.file] = fs.readFileSync(absolute, "utf8");
        } catch {
          errors.push(`Finding file cannot be read: ${finding.file}`);
        }
    }
  if (errors.length) return { ...base, status: "INVALID", findings, context, errors };
  return {
    ...base,
    status: "READY",
    findings,
    context,
    instructions: [
      "Use the active host model and its normal edit tools; do not invoke the AgentSmith review model to write code.",
      "Confirm each selected finding against the current code before editing.",
      "Apply the smallest root-cause fix and add or update a regression test.",
      "Do not suppress deterministic checks or modify unrelated findings.",
      "Run changed/fast checks, re-run AgentSmith review until the selected IDs disappear, then run the full deterministic gate.",
    ],
  };
}
