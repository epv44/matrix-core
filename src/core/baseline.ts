import fs from "node:fs";
import path from "node:path";
import type { BaselineData } from "./types.js";
import { sha256 } from "./hash.js";

export function getBaselinePath(root: string): string {
  return path.join(root, ".quality", "baseline.json");
}

export function loadBaseline(root: string): BaselineData | null {
  const p = getBaselinePath(root);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as BaselineData;
  } catch {
    return null;
  }
}

export function saveBaseline(root: string, metrics: Record<string, number>, configHash?: string): BaselineData {
  const dir = path.join(root, ".quality");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data: BaselineData = {
    version: 1,
    timestamp: new Date().toISOString(),
    configHash,
    metrics,
  };
  const p = getBaselinePath(root);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  return data;
}

export function hashConfig(config: unknown): string {
  const str = JSON.stringify(config);
  return sha256(str, 12);
}

export function diffBaseline(current: Record<string, number | null>, baseline: BaselineData | null) {
  if (!baseline) return [];
  const rows: {
    metric: string;
    baseline: number;
    current: number | null;
    delta: number | null;
    deltaPct: number | null;
  }[] = [];
  for (const [k, bVal] of Object.entries(baseline.metrics)) {
    const cVal = current[k] ?? null;
    if (cVal == null) continue;
    const delta = cVal - bVal;
    const pct = bVal !== 0 ? (delta / Math.abs(bVal)) * 100 : cVal !== 0 ? 100 : 0;
    rows.push({ metric: k, baseline: bVal, current: cVal, delta, deltaPct: pct });
  }
  for (const [k, cVal] of Object.entries(current)) {
    if (cVal == null) continue;
    if (baseline.metrics[k] === undefined) {
      rows.push({ metric: k, baseline: 0, current: cVal, delta: cVal, deltaPct: null });
    }
  }
  return rows;
}
