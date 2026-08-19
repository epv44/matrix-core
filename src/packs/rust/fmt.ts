import type { QualityPlugin } from "../interface.js";
import { cargoWorkspaces, missing, runCargo } from "./common.js";
export const rustFmtPlugin: QualityPlugin = {
  name: "rust.fmt",
  pack: "rust",
  aliases: ["rustfmt", "cargo fmt"],
  async run(ctx, caps) {
    const cap = caps.get("rustfmt") ?? caps.get("rust.fmt");
    if (!cap?.found) return missing("rust.fmt", cap?.required ?? false, "rustfmt", { "rust.fmt.violations": null });
    let violations = 0;
    const observations = [];
    for (const workspace of cargoWorkspaces(ctx.root)) {
      const result = runCargo(ctx, workspace, ["fmt", "--all", "--", "--check"]);
      if (result.status !== 0) {
        violations++;
        observations.push({
          message: (result.stderr || result.stdout || "cargo fmt failed").slice(0, 5000),
          severity: "error" as const,
          ruleId: "rustfmt",
        });
      }
    }
    return {
      plugin: "rust.fmt",
      status: violations ? "FAIL" : "PASS",
      observations,
      metrics: { "rust.fmt.violations": violations },
      reason: violations ? `${violations} workspace(s) need formatting` : undefined,
    };
  },
};
