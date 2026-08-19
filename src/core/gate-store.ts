import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gateStorePath, legacyGateStorePath } from "./meta.js";
import type { GateResult } from "./types.js";

export function writeGateResult(root: string, result: GateResult): void {
  const artifact = result.mode === "full" && !result.fast ? "full" : "changed";
  const target = gateStorePath(root, artifact);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, target);
}

export function readGateResult(root: string, mode: "changed" | "full" = "full"): GateResult | null {
  try {
    const raw = fs.readFileSync(gateStorePath(root, mode), "utf8");
    return JSON.parse(raw) as GateResult;
  } catch {
    return null;
  }
}

export function readLegacyGateResult(root: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(legacyGateStorePath(root), "utf8"));
  } catch {
    return null;
  }
}
