import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cargoWorkspaces, parseCargoDiagnostics } from "../src/packs/rust/common.js";
import { parseRustTests } from "../src/packs/rust/test.js";

describe("Rust pack parsers", () => {
  it("runs only independent top-level Cargo workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-rust-"));
    try {
      fs.writeFileSync(path.join(root, "Cargo.toml"), "[workspace]\nmembers=['member']\n");
      fs.mkdirSync(path.join(root, "member"));
      fs.writeFileSync(path.join(root, "member", "Cargo.toml"), "[package]\nname='member'\nversion='0.1.0'\n");
      fs.mkdirSync(path.join(root, "independent"));
      fs.writeFileSync(
        path.join(root, "independent", "Cargo.toml"),
        "[workspace]\n\n[package]\nname='other'\nversion='0.1.0'\n",
      );
      expect(cargoWorkspaces(root).sort()).toEqual([root, path.join(root, "independent")].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("parses compiler JSON locations and rules", () => {
    const output = JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "warning",
        message: "unused variable",
        code: { code: "unused_variables" },
        spans: [{ file_name: "src/lib.rs", line_start: 3, column_start: 7, is_primary: true }],
      },
    });
    expect(parseCargoDiagnostics(output, "/fixture")[0]).toMatchObject({
      file: "src/lib.rs",
      line: 3,
      col: 7,
      severity: "warn",
      ruleId: "unused_variables",
    });
  });
  it("sums Rust test result totals", () => {
    expect(
      parseRustTests(
        "test result: ok. 3 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 2 failed; 0 ignored",
      ),
    ).toEqual({ passed: 4, failed: 2 });
  });
});
