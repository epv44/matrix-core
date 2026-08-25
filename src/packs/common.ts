import type { CheckCfg, RunCtx } from "../core/types.js";

export function getCheckConfig(ctx: RunCtx, keys: string[]): CheckCfg | undefined {
  for (const key of keys) {
    const config = ctx.config?.checks?.[key];
    if (config) return config;
  }
  return undefined;
}
