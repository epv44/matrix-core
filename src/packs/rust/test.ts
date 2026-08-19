import type { QualityPlugin } from "../interface.js";
import { cargoWorkspaces, missing, runCargo } from "./common.js";
export function parseRustTests(output: string) {
  let passed = 0,
    failed = 0;
  for (const match of output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(match[1]);
    failed += Number(match[2]);
  }
  return { passed, failed };
}
export const rustTestPlugin: QualityPlugin = {
  name: "rust.test",
  pack: "rust",
  aliases: ["cargo test"],
  async run(ctx, caps) {
    const cap = caps.get("cargo") ?? caps.get("rust.test");
    if (!cap?.found)
      return missing("rust.test", cap?.required ?? false, "cargo", {
        "rust.test.passed": null,
        "rust.test.failed": null,
      });
    let passed = 0,
      failed = 0,
      commandFailed = false;
    const observations = [];
    for (const workspace of cargoWorkspaces(ctx.root)) {
      const result = runCargo(ctx, workspace, [
        "test",
        "--workspace",
        "--all-targets",
        "--all-features",
        "--no-fail-fast",
      ]);
      const totals = parseRustTests(`${result.stdout}\n${result.stderr}`);
      passed += totals.passed;
      failed += totals.failed;
      commandFailed ||= result.status !== 0;
      if (result.status !== 0)
        observations.push({
          message: (result.stderr || result.stdout).slice(0, 5000),
          severity: "error" as const,
          ruleId: "cargo-test",
        });
    }
    return {
      plugin: "rust.test",
      status: commandFailed || failed ? "FAIL" : "PASS",
      observations,
      metrics: { "rust.test.passed": passed, "rust.test.failed": failed },
      reason: failed ? `${failed} tests failed` : undefined,
    };
  },
};
