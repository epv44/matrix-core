import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHANGED_GATE_RESULT_FILE,
  COMPLETION_GATE_RESULT_FILE,
  ENGINE_NAME,
  ENGINE_VERSION,
  GATE_STORE_DIR,
  GATE_RESULT_FILE,
  LEGACY_GATE_RESULT_FILE,
  gateStorePath,
  legacyGateStorePath,
} from "../src/core/meta.js";

describe("meta", () => {
  it("exposes engine identity matching package.json", () => {
    expect(ENGINE_NAME).toBe("matrix-core");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("gate store paths are deterministic", () => {
    expect(GATE_STORE_DIR).toBe(".quality");
    expect(CHANGED_GATE_RESULT_FILE).toBe("changed-gate.json");
    expect(COMPLETION_GATE_RESULT_FILE).toBe("completion-gate.json");
    expect(LEGACY_GATE_RESULT_FILE).toBe("gate-result.json");
    expect(GATE_RESULT_FILE).toBe(COMPLETION_GATE_RESULT_FILE);
    expect(gateStorePath("/proj")).toBe(path.join("/proj", ".quality", "completion-gate.json"));
    expect(gateStorePath("/proj", "changed")).toBe(path.join("/proj", ".quality", "changed-gate.json"));
    expect(legacyGateStorePath("/proj")).toBe(path.join("/proj", ".quality", "gate-result.json"));
  });
});
