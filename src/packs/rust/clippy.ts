import type { QualityPlugin } from "../interface.js";
import { cargoWorkspaces, missing, parseCargoDiagnostics, runCargo } from "./common.js";
export const rustClippyPlugin: QualityPlugin = {
  name: "rust.clippy",
  pack: "rust",
  aliases: ["clippy", "cargo clippy"],
  async run(ctx, caps) {
    const cap = caps.get("clippy") ?? caps.get("rust.clippy");
    if (!cap?.found)
      return missing("rust.clippy", cap?.required ?? false, "Clippy", { "rust.clippy.diagnostics": null });
    const observations = [];
    let failed = false;
    for (const workspace of cargoWorkspaces(ctx.root)) {
      const result = runCargo(ctx, workspace, [
        "clippy",
        "--workspace",
        "--all-targets",
        "--all-features",
        "--message-format=json",
        "--",
        "-D",
        "warnings",
      ]);
      observations.push(...parseCargoDiagnostics(result.stdout || "", workspace));
      failed ||= result.status !== 0;
    }
    return {
      plugin: "rust.clippy",
      status: failed ? "FAIL" : "PASS",
      observations,
      metrics: { "rust.clippy.diagnostics": observations.length },
      reason: failed ? `${observations.length} Clippy diagnostics` : undefined,
    };
  },
};
