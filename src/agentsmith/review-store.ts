import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ReviewResult } from "../core/types.js";

export function reviewResultPath(root: string) {
  return path.join(root, ".quality", "review-result.yaml");
}
export function reviewMarkdownPath(root: string) {
  return path.join(root, ".quality", "review-result.md");
}
export function readReviewResult(root: string): ReviewResult | null {
  try {
    const value = yaml.load(fs.readFileSync(reviewResultPath(root), "utf8")) as ReviewResult;
    if (!value || value.schemaVersion !== 2 || !Array.isArray(value.findings) || !value.coverage) return null;
    return value;
  } catch {
    return null;
  }
}
