import type { PluginResult, RunCtx } from "../core/types.js";

export interface QualityPlugin {
  name: string;
  run(ctx: RunCtx, capabilities: Map<string, import("../core/types.js").Capability>): Promise<PluginResult>;
}
