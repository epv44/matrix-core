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
  const { results, capabilities, config, metrics, evaluation, changedMode } = opts;
  const lines: string[] = [];
  lines.push(`=== Quality Engine Report ${changedMode ? "(changed)" : "(full)"} ===`);
  lines.push(`Manifest: ${config.configPath || "unconfigured"}`);
  lines.push(`Root: ${config.configRoot}`);
  lines.push(`Workspace hash: ${config.workspaceHash ?? "unresolved"}`);
  lines.push(`Policy hash: ${config.policy?.policyHash ?? "unresolved"}`);
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

  const byPack: Record<string, PluginResult[]> = {};
  for (const r of results) {
    const pack = (r as any).pack || r.plugin.split(".")[0] || "misc";
    if (!byPack[pack]) byPack[pack] = [];
    byPack[pack].push(r);
  }

  lines.push("Checks:");
  for (const pack of Object.keys(byPack).sort()) {
    lines.push(`  [${pack}]`);
    for (const r of byPack[pack]) {
      const ic = iconForStatus(r.status);
      lines.push(`    ${ic} Plugin: ${r.plugin} Status: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
      if (r.metrics) {
        const mStr = Object.entries(r.metrics)
          .map(([k, v]) => `${k}=${v ?? "undefined"}`)
          .join(", ");
        if (mStr) lines.push(`      Metrics: ${mStr}`);
      }
      if (r.observations.length > 0) {
        const show = r.observations.slice(0, 20);
        for (const o of show) {
          const loc = o.file ? `${o.file}${o.line ? `:${o.line}` : ""}` : "";
          lines.push(`      - [${o.severity}] ${loc} ${o.message}${o.ruleId ? ` (${o.ruleId})` : ""}`);
        }
        if (r.observations.length > 20) lines.push(`      ... ${r.observations.length - 20} more`);
      }
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
    if (hasFail || hasError)
      lines.push(
        `Result: FAILED (${results.filter((r) => r.status === "FAIL").length} FAIL, ${results.filter((r) => r.status === "ERROR").length} ERROR)`,
      );
    else {
      lines.push("Result: PASSED");
    }
  }
  return lines.join("\n");
}

export function formatDoctorReport(doctor: {
  capabilities: Capability[];
  config: ResolvedConfig;
  baselineExists: boolean;
  baselinePath: string;
  gitRepo: boolean;
  warnings?: string[];
}): string {
  const lines: string[] = [];
  lines.push("=== Quality Doctor ===");
  lines.push(
    `Config: ${doctor.config.configPath || "default"} @ ${doctor.config.configRoot} ${doctor.config.isDefault ? "[default]" : ""}`,
  );
  lines.push(`Git repo: ${doctor.gitRepo ? "yes" : "no"}`);
  lines.push(`Workspace hash: ${doctor.config.workspaceHash ?? "unresolved"}`);
  lines.push(`Policy hash: ${doctor.config.policy?.policyHash ?? "unresolved"}`);
  lines.push("");
  const groups: Record<string, Capability[]> = { python: [], typescript: [], other: [] };
  for (const c of doctor.capabilities) {
    if (c.name.startsWith("python:")) groups.python.push(c);
    else if (c.name.startsWith("typescript:")) groups.typescript.push(c);
    else groups.other.push(c);
  }
  for (const [pack, caps] of Object.entries(groups)) {
    if (caps.length === 0) continue;
    lines.push(`[${pack}]`);
    for (const c of caps) {
      const sym = c.found ? "✓" : c.required ? "✗" : "○";
      lines.push(
        `  ${sym} ${c.name} ${c.version || ""} ${c.path || ""} required=${c.required} -> ${c.found ? "found" : "missing"}`,
      );
      if (!c.found && c.hint) lines.push(`    hint: ${c.hint}`);
    }
  }
  const missingRequired = doctor.capabilities.filter((c) => c.required && !c.found);
  if (doctor.warnings?.length) {
    lines.push("");
    lines.push("Warnings:");
    doctor.warnings.forEach((warning) => lines.push(`  ! ${warning}`));
  }
  lines.push("");
  if (missingRequired.length > 0) {
    lines.push(`Doctor: FAILED (${missingRequired.length} required missing)`);
    missingRequired.forEach((c) => lines.push(`  ✗ ${c.name} missing but required`));
  } else {
    lines.push("Doctor: PASSED (all required capabilities found)");
  }
  return lines.join("\n");
}

export function formatVerificationSection(opts: {
  status: string;
  version: string;
  mode?: string;
  timestamp?: string;
  results: PluginResult[];
  failures: string[];
  metrics: Record<string, number | null>;
}): string {
  const counts: Record<string, number> = {};
  for (const r of opts.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const passedTests = opts.metrics["vitest.passed"] ?? opts.metrics["typescript.vitest.passed"];
  const failedTests = opts.metrics["vitest.failed"] ?? opts.metrics["typescript.vitest.failed"];
  const lines: string[] = ["## Verification — MatrixCore quality gate", ""];
  const meta = [
    `**Status:** ${opts.status}`,
    `**Version:** \`${opts.version.slice(0, 12)}\``,
    opts.mode ? `**Mode:** ${opts.mode}` : "",
    opts.timestamp ? `**Time:** ${opts.timestamp}` : "",
  ].filter(Boolean);
  lines.push(meta.join(" · "));
  const countsByStatus = ["PASS", "FAIL", "ERROR", "SKIPPED"]
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);
  lines.push(`**Checks:** ${opts.results.length} → ${countsByStatus.join(" · ") || "none"}`);
  if (passedTests != null || failedTests != null) {
    lines.push(`**Tests:** ${passedTests ?? 0} passed · ${failedTests ?? 0} failed`);
  }
  const bad = opts.results.filter((r) => r.status === "FAIL" || r.status === "ERROR");
  if (bad.length > 0) {
    lines.push("", "| Check | Status | Reason |", "| --- | --- | --- |");
    for (const r of bad) lines.push(`| ${r.plugin} | ${r.status} | ${r.reason || ""} |`);
  }
  if (opts.failures.length > 0) {
    lines.push("", "**Failures:**");
    for (const f of opts.failures.slice(0, 20)) lines.push(`- ${f}`);
  } else {
    lines.push("**Failures:** none");
  }
  return lines.join("\n");
}
