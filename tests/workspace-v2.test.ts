import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLanguageWorkspaces, resolveWorkspaceSet } from "../src/core/workspace.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "matrix-workspaces-"));
}
function write(file: string, value = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

describe("language workspace resolution", () => {
  it("resolves Python at the repository and TypeScript at its owning package", () => {
    const root = temp();
    write(path.join(root, "pyproject.toml"), "[tool.ruff]\nline-length = 1\n[tool.mypy]\nstrict = false\n");
    write(path.join(root, "requirements.txt"));
    write(path.join(root, "app.py"), "value = 1\n");
    write(path.join(root, "frontend/package.json"), '{"name":"frontend"}');
    write(path.join(root, "frontend/package-lock.json"), "{}");
    write(
      path.join(root, "frontend/tsconfig.json"),
      '{"compilerOptions":{"jsx":"react-jsx","paths":{"@/*":["./src/*"]}}}',
    );
    write(path.join(root, "frontend/eslint.config.mjs"), "export default [];\n");
    write(path.join(root, "frontend/src/app.tsx"), "export const App = () => null;\n");
    const realRoot = fs.realpathSync(root);
    expect(
      resolveLanguageWorkspaces(root).map((workspace) => [
        workspace.id,
        path.relative(realRoot, workspace.executionRoot),
      ]),
    ).toEqual([
      ["python:.", ""],
      ["typescript:frontend", "frontend"],
    ]);
    const ts = resolveLanguageWorkspaces(root)[1];
    expect(ts.applicationConfigs).toEqual(["frontend/tsconfig.json"]);
    expect(ts.applicationConfigs).not.toContain("frontend/eslint.config.mjs");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects and excludes Python virtual environments with custom directory names", () => {
    const root = temp();
    write(path.join(root, "app.py"), "value = 1\n");
    write(path.join(root, "fantasy_env/pyvenv.cfg"), "home = /usr/bin\n");
    write(path.join(root, "fantasy_env/lib/python/site-packages/vendor.py"), "vendor = True\n");
    write(path.join(root, "fantasy_env/bin/python"));
    write(path.join(root, "fantasy_env/bin/ruff"));

    const [workspace] = resolveLanguageWorkspaces(root);
    expect(resolveLanguageWorkspaces(root)).toHaveLength(1);
    expect(workspace.resolutionEvidence.some((item) => item.path.includes("site-packages"))).toBe(false);
    expect(workspace.toolEnvironment).toMatchObject({
      kind: "python-venv",
      root: "fantasy_env",
      binaries: { ruff: path.join(fs.realpathSync(root), "fantasy_env/bin/ruff") },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("sorts multiple package roots and fails closed on conflicting locks", () => {
    const root = temp();
    for (const name of ["zeta", "alpha"]) {
      write(path.join(root, name, "package.json"), `{\"name\":\"${name}\"}`);
      write(path.join(root, name, "src/index.ts"), "export {};\n");
    }
    expect(resolveLanguageWorkspaces(root).map((workspace) => workspace.id)).toEqual([
      "typescript:alpha",
      "typescript:zeta",
    ]);
    write(path.join(root, "alpha/package-lock.json"), "{}");
    write(path.join(root, "alpha/yarn.lock"), "");
    expect(() => resolveLanguageWorkspaces(root)).toThrow(/conflicting lockfiles/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers stable central configs and excludes application tests", () => {
    const policy = resolvePolicy();
    expect(policy.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.checks.map((check) => check.id)).toEqual([
      "python.ruff",
      "python.ruff-format",
      "python.mypy",
      "python.xenon",
      "python.deptry",
      "typescript.tsc",
      "typescript.eslint",
      "sql.sqlfluff",
    ]);
    expect(policy.checks.filter((check) => check.configAsset).every((check) => check.configHash)).toBe(true);
    expect(policy.checks.map((check) => check.requiredVersion)).toEqual([
      "0.16.1",
      "0.16.1",
      "2.3.0",
      "0.9.3",
      "0.25.1",
      "5.9.3",
      "9.39.5",
      "4.2.2",
    ]);
  });

  it("attaches explicit SQL facets to the nearest language workspace", () => {
    const root = temp();
    write(path.join(root, "pyproject.toml"), "[project]\nname='sql-app'\n");
    write(path.join(root, "finance/storage.py"), 'conn.execute("SELECT 1")\n');
    const application = {
      sql: [{ root: "finance", dialect: "sqlite", templater: "raw" as const, sources: ["python" as const] }],
    };
    const workspace = resolveLanguageWorkspaces(root, application)[0];
    expect(workspace.sqlFacets).toMatchObject([
      { id: "sql:finance", ownerWorkspaceId: "python:.", dialect: "sqlite", sources: ["python"] },
    ]);
    expect(resolveWorkspaceSet(root, application).workspaceHash).not.toBe(resolveWorkspaceSet(root).workspaceHash);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects overlapping and unsupported SQL facets", () => {
    const root = temp();
    write(path.join(root, "app.py"), "value = 1\n");
    write(path.join(root, "sql/nested/query.sql"), "select 1;\n");
    expect(() =>
      resolveWorkspaceSet(root, {
        sql: [
          { root: "sql", dialect: "sqlite", templater: "raw", sources: ["files"] },
          { root: "sql/nested", dialect: "sqlite", templater: "raw", sources: ["files"] },
        ],
      }),
    ).toThrow(/Overlapping SQL facet roots/);
    expect(() =>
      resolveWorkspaceSet(root, {
        sql: [{ root: "sql", dialect: "not-real", templater: "raw", sources: ["files"] }],
      }),
    ).toThrow(/Unsupported SQLFluff dialect/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when standalone SQL is not declared", () => {
    const root = temp();
    write(path.join(root, "app.py"), "value = 1\n");
    write(path.join(root, "migrations/001.sql"), "select 1;\n");
    expect(() => resolveWorkspaceSet(root)).toThrow(/SQL sources are not covered.*001\.sql/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("produces checkout-independent hashes that change with resolution inputs", () => {
    const first = temp();
    const second = temp();
    for (const root of [first, second]) {
      write(path.join(root, "package.json"), '{"name":"portable"}');
      write(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
      write(path.join(root, "tsconfig.json"), '{"compilerOptions":{"moduleResolution":"bundler"}}');
      write(path.join(root, "src/index.ts"), "export {};\n");
    }
    expect(resolveWorkspaceSet(first).workspaceHash).toBe(resolveWorkspaceSet(second).workspaceHash);
    write(path.join(second, "tsconfig.json"), '{"compilerOptions":{"moduleResolution":"node"}}');
    expect(resolveWorkspaceSet(first).workspaceHash).not.toBe(resolveWorkspaceSet(second).workspaceHash);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });

  it("fails closed on conflicting Python lock ownership", () => {
    const root = temp();
    write(path.join(root, "pyproject.toml"), "[project]\nname='conflict'\n");
    write(path.join(root, "app.py"), "value = 1\n");
    write(path.join(root, "poetry.lock"));
    write(path.join(root, "uv.lock"));
    expect(() => resolveWorkspaceSet(root)).toThrow(/conflicting lockfiles/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
