import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sqlfluffPlugin } from "../src/packs/sql/sqlfluff.js";
import { deptryPlugin } from "../src/packs/python/deptry.js";
import { xenonPlugin } from "../src/packs/python/xenon.js";
import type { LanguageWorkspace, RunCtx, SqlWorkspaceFacet } from "../src/core/types.js";

const python = ["python3", "python"].find(
  (candidate) => spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0,
);

function executable(file: string, body: string) {
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
}

function workspace(root: string, binaries: Record<string, string>): LanguageWorkspace {
  return {
    id: "python:.",
    language: "python",
    sourceRoot: root,
    packageRoot: root,
    executionRoot: root,
    applicationConfigs: [],
    dependencyFiles: ["pyproject.toml"],
    toolEnvironment: { kind: "python-venv", root, binaries: { python: python!, ...binaries } },
    sqlFacets: [],
    resolutionEvidence: [],
    resolutionHash: "workspace",
  };
}

describe.runIf(process.platform !== "win32" && !!python)("new centrally owned Python checks", () => {
  it("reports embedded dynamic SQL as a blocking coverage finding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-sql-plugin-"));
    try {
      const fake = path.join(root, "sqlfluff");
      executable(fake, 'process.stdout.write("[]")');
      fs.writeFileSync(
        path.join(root, "repository.py"),
        ['QUERY = "SELECT id FROM account"', "conn.execute(QUERY)", "conn.execute(query_from_user)"].join("\n"),
      );
      const owner = workspace(root, {});
      const facet: SqlWorkspaceFacet = {
        id: "sql:.",
        ownerWorkspaceId: owner.id,
        sourceRoot: root,
        dialect: "sqlite",
        templater: "raw",
        sources: ["python"],
        toolEnvironment: { kind: "python-venv", root, binaries: { python: python!, sqlfluff: fake } },
        resolutionEvidence: [],
        resolutionHash: "sql",
      };
      owner.sqlFacets = [facet];
      const ctx: RunCtx = {
        root,
        configRoot: root,
        full: true,
        workspace: owner,
        sqlFacet: facet,
        policyCheck: {
          id: "sql.sqlfluff",
          language: "sql",
          tool: "sqlfluff",
          requiredVersion: "4.2.2",
          args: [],
        },
      };
      const result = await sqlfluffPlugin.run(
        ctx,
        new Map([["sqlfluff", { name: "sqlfluff", found: true, required: true }]]),
      );
      expect(result.status).toBe("FAIL");
      expect(result.metrics).toMatchObject({
        "sql.extraction.fragment_count": 1,
        "sql.extraction.unresolved_count": 1,
      });
      expect(result.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "repository.py", line: 3, ruleId: "sql.dynamic-unresolved" }),
        ]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates deptry from project quality configuration and reports only DEP004", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-deptry-plugin-"));
    try {
      const fake = path.join(root, "deptry");
      executable(
        fake,
        [
          'const fs = require("node:fs");',
          'const config = process.argv[process.argv.indexOf("--config") + 1];',
          'if (fs.readFileSync(config, "utf8").includes("tool.deptry")) process.exit(9);',
          'const report = process.argv[process.argv.indexOf("--json-output") + 1];',
          'fs.writeFileSync(report, JSON.stringify([{error:{code:"DEP004",message:"httpx imported but declared as a dev dependency"},location:{file:"app.py",line:2,column:0}}]));',
          "process.exit(1);",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(root, "pyproject.toml"),
        '[project]\nname="app"\nversion="0"\n[tool.deptry]\nignore=["DEP004"]\n',
      );
      fs.writeFileSync(path.join(root, "app.py"), "import httpx\n");
      const owner = workspace(root, { deptry: fake });
      const ctx: RunCtx = {
        root,
        configRoot: root,
        full: true,
        workspace: owner,
        policyCheck: {
          id: "python.deptry",
          language: "python",
          tool: "deptry",
          requiredVersion: "0.25.1",
          args: ["--ignore", "DEP001,DEP002,DEP003,DEP005"],
        },
      };
      const result = await deptryPlugin.run(
        ctx,
        new Map([["deptry", { name: "deptry", found: true, required: true }]]),
      );
      expect(result).toMatchObject({ status: "FAIL", metrics: { "python.deptry.dep004_count": 1 } });
      expect(result.observations[0]).toMatchObject({ ruleId: "DEP004", file: "app.py", line: 2 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the central B/B/A arguments to Xenon", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-xenon-plugin-"));
    try {
      const fake = path.join(root, "xenon");
      executable(
        fake,
        'const required = ["--max-absolute","B","--max-modules","B","--max-average","A"]; process.exit(required.every((v, i) => process.argv.slice(2)[i] === v) ? 0 : 7);',
      );
      const owner = workspace(root, { xenon: fake });
      const ctx: RunCtx = {
        root,
        configRoot: root,
        full: true,
        workspace: owner,
        policyCheck: {
          id: "python.xenon",
          language: "python",
          tool: "xenon",
          requiredVersion: "0.9.3",
          args: ["--max-absolute", "B", "--max-modules", "B", "--max-average", "A"],
        },
      };
      const result = await xenonPlugin.run(ctx, new Map([["xenon", { name: "xenon", found: true, required: true }]]));
      expect(result).toMatchObject({ status: "PASS", metrics: { "python.xenon.violation_count": 0 } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
