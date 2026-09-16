import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = ["python3", "python"].find(
  (candidate) => spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0,
);

describe.runIf(!!python)("embedded Python SQL extraction", () => {
  it("extracts literals and static concatenations while failing closed on dynamic SQL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-sql-extract-"));
    try {
      const source = path.join(root, "repository.py");
      fs.writeFileSync(
        source,
        [
          'BASE = "SELECT id FROM accounts"',
          "def queries(conn, include_removed, order):",
          '    conn.execute("PRAGMA integrity_check")',
          '    conn.execute(BASE + " WHERE id = ?", (1,))',
          '    query = BASE + " WHERE removed = 0"',
          "    if include_removed:",
          '        query += " OR removed = 1"',
          "    conn.execute(query)",
          '    conn.execute(f"SELECT * FROM accounts ORDER BY {order}")',
          "",
        ].join("\n"),
      );
      const request = path.join(root, "request.json");
      fs.writeFileSync(request, JSON.stringify({ files: [source] }));
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const helper = path.join(repo, "src/policy/python-sql-extract.py.txt");
      const run = spawnSync(python!, [helper, request], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.fragments.map((fragment: any) => fragment.sql)).toEqual([
        "PRAGMA integrity_check",
        "SELECT id FROM accounts WHERE id = ?",
      ]);
      expect(result.unresolved).toMatchObject([
        { line: 8, sink: "execute" },
        { line: 9, sink: "execute" },
      ]);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands statically bounded SQL loops and quoted identifiers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-sql-extract-bounded-"));
    try {
      const source = path.join(root, "schema.py");
      fs.writeFileSync(
        source,
        [
          'TABLES = ("accounts", "transactions")',
          "def reset(conn):",
          "    for table in reversed(TABLES):",
          '        conn.execute(f"TRUNCATE TABLE {_quote(table)}")',
          "    for statement in (",
          '        "CREATE TABLE accounts (id integer)",',
          '        "CREATE TABLE transactions (id integer)",',
          "    ):",
          "        conn.execute(statement)",
          "",
        ].join("\n"),
      );
      const request = path.join(root, "request.json");
      fs.writeFileSync(request, JSON.stringify({ files: [source] }));
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const helper = path.join(repo, "src/policy/python-sql-extract.py.txt");
      const run = spawnSync(python!, [helper, request], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.fragments.map((fragment: any) => fragment.sql)).toEqual([
        'TRUNCATE TABLE "transactions"',
        'TRUNCATE TABLE "accounts"',
        "CREATE TABLE accounts (id integer)",
        "CREATE TABLE transactions (id integer)",
      ]);
      expect(result.unresolved).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
