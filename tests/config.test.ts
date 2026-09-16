import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/core/config-resolver.js";

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "matrix-config-"));
}

describe("v2 project manifest", () => {
  it("accepts a public GitHub policy source without resolving the network", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-config-policy-"));
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: remote\npolicy:\n  source: github\n  repository: acme/policy\n  ref: stable\n  manifest: matrixcore/policy.json\n",
    );
    expect(resolveConfig({ cwd: root }).config.policySource).toEqual({
      source: "github",
      repository: "acme/policy",
      ref: "stable",
      manifest: "matrixcore/policy.json",
    });
  });
  it("resolves the nearest strict v2 manifest", () => {
    const root = temp();
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: root\n");
    fs.writeFileSync(path.join(child, "quality.yaml"), "version: 2\nproject: child\nreview:\n  agentsmith: true\n");
    expect(resolveConfig({ cwd: child }).config).toMatchObject({
      version: 2,
      project: "child",
      review: { agentsmith: true },
      agentsmith: { enabled: true },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves repositories without a manifest unconfigured", () => {
    const root = temp();
    const resolved = resolveConfig({ cwd: root });
    expect(resolved.isDefault).toBe(true);
    expect(resolved.config).toMatchObject({ version: 2, agentsmith: { enabled: false } });
    expect(resolved.config.agentsmith?.model_profiles.map((profile) => profile.id)).toEqual(
      expect.arrayContaining(["qwen35-9b-local", "qwen35-122b-local"]),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects v1 with migration guidance", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 1\nchecks: {}\n");
    expect(() => resolveConfig({ cwd: root })).toThrow(/v1 is no longer supported.*Migrate/s);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["checks", "policies", "packs", "stages", "gates", "agentsmith"])("rejects project-owned %s", (field) => {
    const root = temp();
    fs.writeFileSync(path.join(root, "quality.yaml"), `version: 2\nproject: app\n${field}: {}\n`);
    expect(() => resolveConfig({ cwd: root })).toThrow(/Invalid MatrixCore v2 manifest/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts only SQL application-resolution metadata", () => {
    const root = temp();
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: app\napplication:\n  sql:\n    - root: finance\n      dialect: sqlite\n      templater: raw\n      sources: [files, python]\n",
    );
    expect(resolveConfig({ cwd: root }).config.application).toEqual({
      sql: [{ root: "finance", dialect: "sqlite", templater: "raw", sources: ["files", "python"] }],
    });
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: app\napplication:\n  sql:\n    - root: finance\n      dialect: sqlite\n      templater: raw\n      sources: [python]\n      rules: [LT01]\n",
    );
    expect(() => resolveConfig({ cwd: root })).toThrow(/Invalid MatrixCore v2 manifest/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts SQLFluff templater options and preserves them in application metadata", () => {
    const root = temp();
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: app\napplication:\n  sql:\n    - root: finance\n      dialect: postgres\n      templater: placeholder\n      templater_options:\n        param_style: percent\n      sources: [python]\n",
    );
    expect(resolveConfig({ cwd: root }).config.application).toEqual({
      sql: [
        {
          root: "finance",
          dialect: "postgres",
          templater: "placeholder",
          templater_options: { param_style: "percent" },
          sources: ["python"],
        },
      ],
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
