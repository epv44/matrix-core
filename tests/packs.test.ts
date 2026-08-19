import { describe, it, expect } from "vitest";
import {
  ALL_PLUGINS,
  ALIAS_MAP,
  resolveCanonicalKey,
  getPluginByName,
  getPluginsForPack,
} from "../src/packs/registry.js";
import { ruffPlugin } from "../src/packs/python/ruff.js";
import { ruffFormatPlugin } from "../src/packs/python/ruff-format.js";
import { mypyPlugin } from "../src/packs/python/mypy.js";
import { pytestPlugin } from "../src/packs/python/pytest.js";
import { xenonPlugin } from "../src/packs/python/xenon.js";
import { deptryPlugin } from "../src/packs/python/deptry.js";
import { tscPlugin } from "../src/packs/typescript/tsc.js";
import { eslintPlugin } from "../src/packs/typescript/eslint.js";
import { prettierPlugin } from "../src/packs/typescript/prettier.js";
import { vitestPlugin } from "../src/packs/typescript/vitest.js";
import { complexityPlugin } from "../src/packs/typescript/complexity.js";
import { golangciPlugin } from "../src/packs/go/golangci.js";
import { govetPlugin } from "../src/packs/go/govet.js";
import { gotestPlugin } from "../src/packs/go/gotest.js";
import type { RunCtx, Capability, PluginResult } from "../src/core/types.js";

function baseCtx(over: Partial<RunCtx> = {}): RunCtx {
  return {
    root: "/tmp/matrix-packs",
    configRoot: "/tmp/matrix-packs",
    full: false,
    config: { version: 1, checks: {}, policies: {} },
    ...over,
  };
}

function capMap(name: string, over: Partial<Capability> = {}): Map<string, Capability> {
  return new Map([[name, { name, found: true, required: false, ...over }]]);
}

async function expectStatus(
  promise: Promise<PluginResult>,
  status: PluginResult["status"],
  reasonPart?: string,
): Promise<PluginResult> {
  const r = await promise;
  expect(r.status).toBe(status);
  if (reasonPart) expect(r.reason).toContain(reasonPart);
  return r;
}

describe("pack registry", () => {
  it("registers 15 plugins across the deterministic packs", () => {
    expect(ALL_PLUGINS.length).toBe(15);
    expect(new Set(ALL_PLUGINS.map((p) => p.pack))).toEqual(new Set(["python", "sql", "typescript", "go"]));
    expect(getPluginsForPack("python").map((p) => p.name)).toEqual([
      "python.ruff",
      "python.ruff-format",
      "python.mypy",
      "python.pytest",
      "python.xenon",
      "python.deptry",
    ]);
    expect(getPluginsForPack("typescript").length).toBe(5);
    expect(getPluginsForPack("go").length).toBe(3);
  });

  it("resolves aliases to canonical keys and back", () => {
    expect(ALIAS_MAP["ruff"]).toBe("python.ruff");
    expect(resolveCanonicalKey("jest")).toBe("typescript.vitest");
    expect(resolveCanonicalKey("go vet")).toBe("go.vet");
    expect(resolveCanonicalKey("python.ruff")).toBe("python.ruff");
    expect(resolveCanonicalKey("unknown-key")).toBe("unknown-key");
  });

  it("finds plugins by canonical name or alias", () => {
    expect(getPluginByName("ruff")?.name).toBe("python.ruff");
    expect(getPluginByName("python.pytest")?.name).toBe("python.pytest");
    expect(getPluginByName("golangci-lint")?.name).toBe("go.golangci");
    expect(getPluginByName("nope")).toBeUndefined();
  });
});

describe("python pack plugins", () => {
  it("ruff: missing required -> FAIL, optional -> SKIPPED, no py changed -> PASS", async () => {
    await expectStatus(ruffPlugin.run(baseCtx(), capMap("ruff", { found: false, required: true })), "FAIL");
    await expectStatus(ruffPlugin.run(baseCtx(), capMap("ruff", { found: false, required: false })), "SKIPPED");
    await expectStatus(ruffPlugin.run(baseCtx(), new Map()), "FAIL", "executable not found");
    await expectStatus(
      ruffPlugin.run(baseCtx({ changedFiles: ["README.md"] }), capMap("ruff")),
      "PASS",
      "no python files changed",
    );
  });

  it("ruff-format: missing optional -> SKIPPED, required -> FAIL, no py changed -> PASS", async () => {
    await expectStatus(ruffFormatPlugin.run(baseCtx(), capMap("ruff", { found: false, required: false })), "SKIPPED");
    await expectStatus(ruffFormatPlugin.run(baseCtx(), capMap("ruff", { found: false, required: true })), "FAIL");
    await expectStatus(
      ruffFormatPlugin.run(baseCtx({ changedFiles: ["README.md"] }), capMap("ruff")),
      "PASS",
      "no python files changed",
    );
  });

  it("mypy: missing optional -> SKIPPED, required -> FAIL, no py changed -> PASS", async () => {
    await expectStatus(mypyPlugin.run(baseCtx(), capMap("mypy", { found: false, required: false })), "SKIPPED");
    await expectStatus(mypyPlugin.run(baseCtx(), capMap("mypy", { found: false, required: true })), "FAIL");
    await expectStatus(
      mypyPlugin.run(baseCtx({ changedFiles: ["README.md"] }), capMap("mypy")),
      "PASS",
      "no python files changed",
    );
  });

  it("pytest: fast defers, missing required -> FAIL, no relevant changes -> PASS", async () => {
    await expectStatus(pytestPlugin.run(baseCtx({ fast: true }), new Map()), "SKIPPED", "fast mode");
    await expectStatus(pytestPlugin.run(baseCtx(), new Map()), "FAIL", "executable not found");
    await expectStatus(
      pytestPlugin.run(baseCtx({ changedFiles: ["README.md"] }), capMap("pytest")),
      "PASS",
      "no relevant files changed",
    );
  });

  it("xenon and deptry fail when their designated tools are absent", async () => {
    await expectStatus(xenonPlugin.run(baseCtx(), new Map()), "FAIL", "required workspace tool missing");
    await expectStatus(deptryPlugin.run(baseCtx(), new Map()), "FAIL", "required workspace tool missing");
  });
});

describe("typescript pack plugins", () => {
  it("tsc: missing optional -> SKIPPED, required -> FAIL, no ts changed -> PASS", async () => {
    await expectStatus(tscPlugin.run(baseCtx(), capMap("typescript", { found: false, required: false })), "SKIPPED");
    await expectStatus(tscPlugin.run(baseCtx(), capMap("typescript", { found: false, required: true })), "FAIL");
    await expectStatus(
      tscPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("typescript")),
      "PASS",
      "no ts files changed",
    );
  });

  it("eslint: missing optional -> SKIPPED, required -> FAIL, no ts/js changed -> PASS", async () => {
    await expectStatus(eslintPlugin.run(baseCtx(), capMap("eslint", { found: false, required: false })), "SKIPPED");
    await expectStatus(eslintPlugin.run(baseCtx(), capMap("eslint", { found: false, required: true })), "FAIL");
    await expectStatus(
      eslintPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("eslint")),
      "PASS",
      "no ts/js files changed",
    );
  });

  it("prettier: missing optional -> SKIPPED, required -> FAIL, no supported changed -> PASS", async () => {
    await expectStatus(prettierPlugin.run(baseCtx(), capMap("prettier", { found: false, required: false })), "SKIPPED");
    await expectStatus(prettierPlugin.run(baseCtx(), capMap("prettier", { found: false, required: true })), "FAIL");
    await expectStatus(
      prettierPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("prettier")),
      "PASS",
      "no supported files changed",
    );
  });

  it("vitest: missing optional -> SKIPPED, required -> FAIL, no relevant ts changed -> PASS", async () => {
    await expectStatus(vitestPlugin.run(baseCtx(), capMap("vitest", { found: false, required: false })), "SKIPPED");
    await expectStatus(vitestPlugin.run(baseCtx(), capMap("vitest", { found: false, required: true })), "FAIL");
    await expectStatus(
      vitestPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("vitest")),
      "PASS",
      "no relevant ts files changed",
    );
  });

  it("complexity: stub always skipped", async () => {
    await expectStatus(complexityPlugin.run(), "SKIPPED", "stub");
  });
});

describe("go pack plugins", () => {
  it("golangci: missing optional -> SKIPPED, required -> FAIL, no go changed -> PASS", async () => {
    await expectStatus(
      golangciPlugin.run(baseCtx(), capMap("golangci-lint", { found: false, required: false })),
      "SKIPPED",
    );
    await expectStatus(
      golangciPlugin.run(baseCtx(), capMap("golangci-lint", { found: false, required: true })),
      "FAIL",
    );
    await expectStatus(
      golangciPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("golangci-lint")),
      "PASS",
      "no go files changed",
    );
  });

  it("go vet: missing optional -> SKIPPED, required -> FAIL, no go changed -> PASS", async () => {
    await expectStatus(govetPlugin.run(baseCtx(), capMap("go", { found: false, required: false })), "SKIPPED");
    await expectStatus(govetPlugin.run(baseCtx(), capMap("go", { found: false, required: true })), "FAIL");
    await expectStatus(
      govetPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("go")),
      "PASS",
      "no go files changed",
    );
  });

  it("go test: missing optional -> SKIPPED, required -> FAIL, no go changed -> PASS", async () => {
    await expectStatus(gotestPlugin.run(baseCtx(), capMap("go", { found: false, required: false })), "SKIPPED");
    await expectStatus(gotestPlugin.run(baseCtx(), capMap("go", { found: false, required: true })), "FAIL");
    await expectStatus(
      gotestPlugin.run(baseCtx({ changedFiles: ["a.py"] }), capMap("go")),
      "PASS",
      "no go files changed",
    );
  });
});
