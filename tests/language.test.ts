import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectLanguages } from "../src/core/language.js";

function write(root: string, rel: string, content = "") {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("detectLanguages", () => {
  it("empty dir detects nothing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-lang-"));
    try {
      expect(detectLanguages(root)).toEqual({ python: false, typescript: false, go: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects python, typescript and go from extensions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-lang-"));
    try {
      write(root, "app.py");
      write(root, "src/index.tsx");
      write(root, "go.mod");
      expect(detectLanguages(root)).toEqual({ python: true, typescript: true, go: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips vendored and build directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-lang-"));
    try {
      write(root, "node_modules/dep/x.py");
      write(root, "dist/bundle.ts");
      write(root, ".venv/lib.py");
      expect(detectLanguages(root)).toEqual({ python: false, typescript: false, go: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores dotfiles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-lang-"));
    try {
      write(root, ".hidden.py");
      expect(detectLanguages(root)).toEqual({ python: false, typescript: false, go: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tsconfig.json alone marks typescript", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-lang-"));
    try {
      write(root, "tsconfig.json", "{}");
      expect(detectLanguages(root).typescript).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
