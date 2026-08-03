import type { PluginResult, Capability, BaselineData, ResolvedConfig } from "./types.js";
import type { PolicyEvaluation } from "./policy.js";

function iconForStatus(s: string) {
  switch (s) {
    case "PASS":
      return "✓";
    case "FAIL":
      return "✗";
    case "SKIPPED":
      return "○";
    case "ERROR":
      return "!";
    default:
      return "?";
  }
}

export function formatReport(opts: {
  results: PluginResult[];
  capabilities: Capability[];
  config: ResolvedConfig;
  baseline: BaselineData | null;
  metrics: Record<string, number | null>;
  evaluation: PolicyEvaluation;
  changedMode?: boolean;
}): string {
  const { results, capabilities, config, baseline, metrics, evaluation, changedMode } = opts;
  const lines: string[] = [];
  lines.push(`=== Quality Engine Report ${changedMode ? "(changed)" : "(full)"} ===`);
  lines.push(`Config: ${config.configPath || "default (embedded)"} ${config.isDefault ? "[default]" : ""}`);
  lines.push(`Root: ${config.configRoot}`);
  lines.push(`Baseline: ${baseline ? `found ${baseline.timestamp}` : "not found"}`);
  lines.push("");

  lines.push("Capabilities:");
  for (const c of capabilities) {
    const sym = c.found ? "✓" : c.required ? "✗" : "○";
    const extra = c.version ? ` ${c.version}` : "";
    const p = c.path ? ` ${c.path}` : "";
    const req = ` required=${c.required}`;
    const status = c.found ? "found" : c.required ? "MISSING" : "missing (optional)";
    lines.push(`  ${sym} ${c.name}${extra}${p} -> ${status}${req}`);
    if (!c.found && c.hint) lines.push(`    hint: ${c.hint}`);
  }
  lines.push("");

  lines.push("Checks:");
  for (const r of results) {
    const ic = iconForStatus(r.status);
    lines.push(`  ${ic} Plugin: ${r.plugin} Status: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
    if (r.metrics) {
      const mStr = Object.entries(r.metrics)
        .map(([k, v]) => `${k}=${v ?? "undefined"}`)
        .join(", ");
      if (mStr) lines.push(`    Metrics: ${mStr}`);
    }
    if (r.observations.length > 0) {
      const show = r.observations.slice(0, 20);
      for (const o of show) {
        const loc = o.file ? `${o.file}${o.line ? `:${o.line}` : ""}` : "";
        lines.push(`    - [${o.severity}] ${loc} ${o.message}${o.ruleId ? ` (${o.ruleId})` : ""}`);
      }
      if (r.observations.length > 20) lines.push(`    ... ${r.observations.length - 20} more`);
    }
  }
  lines.push("");

  lines.push("Aggregated Metrics:");
  if (Object.keys(metrics).length === 0) lines.push("  (none)");
  else for (const [k, v] of Object.entries(metrics)) lines.push(`  ${k}: ${v ?? "undefined"}`);

  lines.push("");
  if (evaluation.warnings.length > 0) {
    lines.push("Warnings:");
    evaluation.warnings.forEach((w) => lines.push(`  ! ${w}`));
    lines.push("");
  }
  if (evaluation.failures.length > 0) {
    lines.push("Policy Failures:");
    evaluation.failures.forEach((f) => lines.push(`  ✗ ${f}`));
    lines.push("");
    lines.push("Result: FAILED");
  } else {
    const hasFail = results.some((r) => r.status === "FAIL");
    const hasError = results.some((r) => r.status === "ERROR");
    if (hasFail || hasError) {
      lines.push(`Result: FAILED (${results.filter((r) => r.status === "FAIL").length} FAIL, ${results.filter((r) => r.status === "ERROR").length} ERROR)`);
    } else {
      lines.push("Result: PASSED");
      if (!baseline) {
        lines.push("");
        lines.push("No baseline found. Run: quality baseline create");
      }
    }
  }

  return lines.join("\n");
}

export function formatDoctorReport(doctor: { capabilities: Capability[]; config: ResolvedConfig; baselineExists: boolean; baselinePath: string; gitRepo: boolean }): string {
  const lines: string[] = [];
  lines.push("=== Quality Doctor ===");
  lines.push(`Config: ${doctor.config.configPath || "default"} @ ${doctor.config.configRoot} ${doctor.config.isDefault ? "[default]" : ""}`);
  lines.push(`Git repo: ${doctor.gitRepo ? "yes" : "no"}`);
  lines.push(`Baseline: ${doctor.baselineExists ? `found at ${doctor.baselinePath}` : `not found (expected at ${doctor.baselinePath})`}`);
  lines.push("");
  lines.push("Capabilities:");
  for (const c of doctor.capabilities) {
    const sym = c.found ? "✓" : c.required ? "✗" : "○";
    lines.push(`  ${sym} ${c.name} ${c.version || ""} ${c.path || ""} required=${c.required} -> ${c.found ? "found" : "missing"}`);
    if (!c.found && c.hint) lines.push(`    hint: ${c.hint}`);
  }
  const missingRequired = doctor.capabilities.filter((c) => c.required && !c.found);
  lines.push("");
  if (missingRequired.length > 0) {
    lines.push(`Doctor: FAILED (${missingRequired.length} required missing)`);
    missingRequired.forEach((c) => lines.push(`  ✗ ${c.name} missing but required`));
  } else {
    lines.push("Doctor: PASSED (all required capabilities found)");
  }
  return lines.join("\n");
}
