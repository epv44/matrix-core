import type { QualityPlugin } from "../interface.js";
import type { PluginResult } from "../../core/types.js";

export const complexityPlugin: QualityPlugin = {
  name: "typescript.complexity",
  pack: "typescript",
  aliases: ["complexity", "ts-complexity"],
  async run(): Promise<PluginResult> {
    return {
      plugin: "typescript.complexity",
      status: "SKIPPED",
      observations: [
        {
          message: "typescript complexity - stub not implemented, planned for future (e.g., ts-complex, typhon)",
          severity: "info",
        },
      ],
      metrics: { "typescript.complexity.max": null, "complexity.max": null },
      reason: "stub - not implemented",
    };
  },
};
