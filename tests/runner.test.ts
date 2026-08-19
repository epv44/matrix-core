import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEngine, scopeChangedFiles, versionAccepted } from "../src/core/runner.js";

describe("v2 policy runner", () => {
  it("requires the exact central semantic version", () => {
    expect(versionAccepted("0.16.1", "0.16.1")).toBe(true);
    expect(versionAccepted("0.16.0", "0.16.1")).toBe(false);
    expect(versionAccepted("0.17.1", "0.16.1")).toBe(false);
  });
  it("scopes files to a resolved package", () => {
    expect(scopeChangedFiles(["frontend/src/app.ts", "server.py"], "/repo", "/repo/frontend")).toEqual(["src/app.ts"]);
  });

  it("passes with no language workspaces and emits no synthetic skips", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-runner-"));
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: empty\n");
    const result = await runEngine({ cwd: root });
    expect(result).toMatchObject({ passed: true, results: [] });
    expect(result.config.policy?.checks).toHaveLength(8);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails when tools exist only globally and not in the designated package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-runner-"));
    fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: missing-tools\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"missing-tools"}');
    fs.writeFileSync(path.join(root, "index.ts"), "export {};\n");
    const result = await runEngine({ cwd: root });
    expect(result.passed).toBe(false);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: "typescript.tsc",
          status: "FAIL",
          reason: "required workspace tool missing",
        }),
        expect.objectContaining({
          plugin: "typescript.eslint",
          status: "FAIL",
          reason: "required workspace tool missing",
        }),
      ]),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});
