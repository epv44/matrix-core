import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".quality",
  ".next",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  "node_modules",
  "__pycache__",
]);

export function atomicWriteFile(target: string, contents: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, mode === undefined ? undefined : { mode });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function isWithinMatrixCoreIgnore(rootInput: string, targetInput: string): boolean {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  let current = (() => {
    try {
      return fs.statSync(target).isDirectory() ? target : path.dirname(target);
    } catch {
      return path.dirname(target);
    }
  })();
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (fs.existsSync(path.join(current, ".matrixcore-ignore"))) return true;
    current = path.dirname(current);
  }
  return false;
}

export function walkFiles(
  root: string,
  visit: (file: string) => void,
  ignoredDirectories: ReadonlySet<string> = DEFAULT_IGNORED_DIRECTORIES,
): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory() && fs.existsSync(path.join(absolute, ".matrixcore-ignore"))) continue;
    if (entry.isDirectory() && fs.existsSync(path.join(absolute, "pyvenv.cfg"))) continue;
    if (entry.isDirectory()) walkFiles(absolute, visit, ignoredDirectories);
    else if (entry.isFile()) visit(absolute);
  }
}
