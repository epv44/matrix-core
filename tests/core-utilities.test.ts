import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChangedRanges } from "../src/core/diff.js";
import { atomicWriteFile, readJsonFile, walkFiles } from "../src/core/filesystem.js";
import { sha256, sha256Json } from "../src/core/hash.js";
import { isMainModule, isProcessAlive } from "../src/core/process.js";

describe("shared core utilities", () => {
  it("preserves raw and JSON SHA-256 semantics", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Json({ a: 1 })).toBe(sha256(JSON.stringify({ a: 1 })));
    expect(sha256("abc", 12)).toBe("ba7816bf8f01");
  });

  it("atomically replaces files and tolerantly reads JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-filesystem-"));
    const target = path.join(root, "nested", "state.json");
    atomicWriteFile(target, '{"value":1}\n');
    expect(readJsonFile<{ value: number }>(target)).toEqual({ value: 1 });
    atomicWriteFile(target, "invalid");
    expect(readJsonFile(target)).toBeNull();
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("walks files deterministically and skips generated directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-walk-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.mkdirSync(path.join(root, "fixture"));
    fs.writeFileSync(path.join(root, "z.txt"), "z");
    fs.writeFileSync(path.join(root, "src", "a.txt"), "a");
    fs.writeFileSync(path.join(root, "node_modules", "ignored.txt"), "ignored");
    fs.writeFileSync(path.join(root, "fixture", ".matrixcore-ignore"), "");
    fs.writeFileSync(path.join(root, "fixture", "ignored.txt"), "ignored");
    const files: string[] = [];
    walkFiles(root, (file) => files.push(path.relative(root, file)));
    expect(files).toEqual([path.join("src", "a.txt"), "z.txt"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects process liveness and ESM entrypoints", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
    const executable = fs.realpathSync(process.argv[1]);
    expect(isMainModule(pathToFileURL(executable).href, executable)).toBe(true);
    expect(isMainModule(import.meta.url, "/missing/matrixcore-entrypoint")).toBe(false);
  });

  it("parses additions, deletions, renames, and multiple hunks", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "+++ b/new.ts",
      "@@ -2,2 +3,4 @@",
      "@@ -20,3 +24,0 @@",
      "diff --git a/gone.ts b/gone.ts",
      "+++ /dev/null",
      "@@ -5,2 +0,0 @@",
    ].join("\n");
    expect(parseChangedRanges(diff)).toEqual([
      { file: "new.ts", start: 3, end: 6 },
      { file: "new.ts", start: 20, end: 22 },
      { file: "gone.ts", start: 5, end: 6 },
    ]);
  });
});
