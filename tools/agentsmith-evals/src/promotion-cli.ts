import fs from "node:fs";
import path from "node:path";
import { evaluateReviewPromotion } from "./promotion.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

const baselinePath = path.resolve(option("--baseline"));
const currentPath = path.resolve(option("--current"));
const result = evaluateReviewPromotion(
  JSON.parse(fs.readFileSync(baselinePath, "utf8")),
  JSON.parse(fs.readFileSync(currentPath, "utf8")),
);
console.log(JSON.stringify({ baseline: baselinePath, current: currentPath, ...result }, null, 2));
if (!result.ok) process.exitCode = 1;

