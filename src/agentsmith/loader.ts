import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface AssetDoc {
  name: string;
  description: string;
  content: string;
}

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function assetPath(rel: string, root = BASE_DIR): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, rel);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`))
    throw new Error(`Unsafe AgentSmith asset path: ${rel}`);
  return candidate;
}

export function readAsset(rel: string, root?: string): string {
  return fs.readFileSync(assetPath(rel, root), "utf8");
}

export function parseAssetDoc(raw: string): { frontmatter: Record<string, string>; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, content: raw.trim() };
  let parsed: Record<string, unknown> = {};
  try {
    const value = yaml.load(match[1]);
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) frontmatter[key] = String(value);
  return { frontmatter, content: match[2].trim() };
}

export function loadDoc(rel: string, fallbackName: string, root?: string): AssetDoc {
  const { frontmatter, content } = parseAssetDoc(readAsset(rel, root));
  return {
    name: frontmatter["name"] || fallbackName,
    description: frontmatter["description"] ?? "",
    content,
  };
}
