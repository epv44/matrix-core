import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../../src/core/resolved-policy.js";

describe("v2 review model role configuration", () => {
  it("lets projects bind roles only to locked profiles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-model-roles-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        [
          "version: 2",
          "project: roles",
          "review:",
          "  agentsmith: true",
          "  mode: hybrid",
          "  models:",
          "    candidate: qwen35-9b-local",
          "    scout: qwen35-122b-local",
          "    verifier: qwen35-122b-local",
          "",
        ].join("\n"),
      );
      const resolved = resolveConfig({ cwd: root });
      resolvePolicyForConfig(resolved);
      expect(resolved.config.agentsmith).toMatchObject({
        mode: "hybrid",
        models: { candidate: "qwen35-9b-local", scout: "qwen35-122b-local", verifier: "qwen35-122b-local" },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown role profiles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-model-roles-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: roles\nreview:\n  agentsmith: true\n  models:\n    candidate: arbitrary-model\n",
      );
      const resolved = resolveConfig({ cwd: root });
      expect(() => resolvePolicyForConfig(resolved)).toThrow(/not approved/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
