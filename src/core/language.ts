import fs from "node:fs";
import path from "node:path";

export interface LanguageSet {
  python: boolean;
  typescript: boolean;
  go: boolean;
  rust: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  "build",
  ".nx",
  ".yarn",
  ".turbo",
  ".quality",
]);

export function detectLanguages(root: string): LanguageSet {
  const found = { python: false, typescript: false, go: false } as LanguageSet;
  Object.defineProperty(found, "rust", { value: false, writable: true, enumerable: false });
  const stack: string[] = [root];
  let checked = 0;
  while (stack.length > 0 && checked < 20000) {
    const dir = stack.pop()!;
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (checked++ > 20000) break;
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      if (e.name.endsWith(".py")) found.python = true;
      if (e.name.endsWith(".ts") || e.name.endsWith(".tsx") || e.name.endsWith(".mts") || e.name === "tsconfig.json")
        found.typescript = true;
      if (e.name.endsWith(".go") || e.name === "go.mod") found.go = true;
      if (e.name.endsWith(".rs") || e.name === "Cargo.toml") found.rust = true;
      if (found.python && found.typescript && found.go && found.rust) return found;
    }
  }
  return found;
}
