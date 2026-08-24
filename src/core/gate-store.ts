import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ACTIVE_COMPLETION_GATE_FILE, gateStorePath, legacyGateStorePath, qualityStorePath } from "./meta.js";
import type { GateResult } from "./types.js";

export function writeGateResult(root: string, result: GateResult): void {
  const artifact = result.mode === "full" && !result.fast ? "full" : "changed";
  const target = gateStorePath(root, artifact);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, target);
}

export function writeActiveGateRun(root: string, runId: string, result: GateResult): void {
  if (result.mode !== "full") return;
  const target = qualityStorePath(root, ACTIVE_COMPLETION_GATE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, runId, result }, null, 2));
  fs.renameSync(tmp, target);
}

export function clearActiveGateRun(root: string, runId: string): void {
  const target = qualityStorePath(root, ACTIVE_COMPLETION_GATE_FILE);
  try {
    const current = JSON.parse(fs.readFileSync(target, "utf8")) as { runId?: string };
    if (current.runId === runId) fs.unlinkSync(target);
  } catch {}
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
