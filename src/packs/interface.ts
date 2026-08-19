import type { PluginResult, Capability, RunCtx } from "../core/types.js";
export interface QualityPlugin {
  name: string;
  pack: string;
  aliases?: string[];
  run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult>;
}
export interface QualityPack {
  id: string;
  extensions: string[];
  manifests: string[];
  capabilities: string[];
  rule?: string;
  plugins: QualityPlugin[];
}
