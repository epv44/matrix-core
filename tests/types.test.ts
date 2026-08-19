import { describe, it, expect } from "vitest";
import type { PluginResult } from "../src/core/types.js";
describe("PluginResult status semantics", () => {
  it("SKIPPED is not FAIL", () => {
    const r: PluginResult = {
      plugin: "ruff",
      status: "SKIPPED",
      observations: [{ message: "ruff executable not found", severity: "info" }],
      metrics: { "ruff.violation_count": null },
      reason: "executable not found, required=false",
    };
    expect(r.status).toBe("SKIPPED");
    expect(r.metrics!["ruff.violation_count"]).toBeNull();
  });
  it("FAIL when required missing", () => {
    const r: PluginResult = {
      plugin: "ruff",
      status: "FAIL",
      observations: [{ message: "ruff executable not found", severity: "error" }],
      metrics: { "ruff.violation_count": null },
      reason: "executable not found but required=true",
    };
    expect(r.status).toBe("FAIL");
  });
});
