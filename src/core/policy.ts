import type { QualityConfig, BaselineData, PluginResult } from "./types.js";

export interface PolicyEvaluation {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

export function evaluatePolicy(
  metrics: Record<string, number | null>,
  config: QualityConfig,
  baseline: BaselineData | null
): PolicyEvaluation {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const [policyName, p] of Object.entries(config.policies || {})) {
    const metricKey = p.metric;
    const current = metrics[metricKey];

    if (current == null) {
      const isCoverage = metricKey.includes("coverage");
      const covRequired = config.checks["coverage"]?.required ?? false;
      if (isCoverage && !covRequired) {
        warnings.push(`Policy ${policyName}: metric ${metricKey} unavailable, skipped (coverage not required)`);
        continue;
      }
      warnings.push(`Policy ${policyName}: metric ${metricKey} unavailable`);
      continue;
    }

    if (p.absolute_min !== undefined && current < p.absolute_min) {
      failures.push(`Policy ${policyName}: ${metricKey}=${current} below absolute_min ${p.absolute_min}`);
    }
    if (p.max !== undefined && current > p.max) {
      failures.push(`Policy ${policyName}: ${metricKey}=${current} exceeds max ${p.max}`);
    }

    if (baseline && baseline.metrics[metricKey] !== undefined) {
      const baseVal = baseline.metrics[metricKey];
      if (p.degradation_allowed !== undefined) {
        const allowedDrop = p.degradation_allowed;
        const minAllowed = baseVal * (1 - allowedDrop / 100);
        if (current < minAllowed) {
          const drop = baseVal === 0 ? 0 : ((baseVal - current) / Math.abs(baseVal)) * 100;
          failures.push(
            `Policy ${policyName}: ${metricKey} degraded ${drop.toFixed(2)}% from baseline ${baseVal} -> ${current}, allowed ${allowedDrop}%`
          );
        }
      }
      if (p.max_increase_percent !== undefined) {
        const maxAllowed = baseVal * (1 + p.max_increase_percent / 100);
        if (baseVal >= 0 && current > maxAllowed) {
          const inc = baseVal === 0 ? (current > 0 ? 100 : 0) : ((current - baseVal) / Math.abs(baseVal)) * 100;
          failures.push(
            `Policy ${policyName}: ${metricKey} increased ${inc.toFixed(2)}% from baseline ${baseVal} -> ${current}, allowed ${p.max_increase_percent}%`
          );
        }
        if (baseVal < 0 && current > baseVal) {
        }
      }
    }
  }

  return { passed: failures.length === 0, failures, warnings };
}

export function aggregateMetrics(results: PluginResult[]): Record<string, number | null> {
  const metrics: Record<string, number | null> = {};
  for (const r of results) {
    if (r.metrics) {
      for (const [k, v] of Object.entries(r.metrics)) {
        metrics[k] = v ?? null;
      }
    }
  }
  return metrics;
}
