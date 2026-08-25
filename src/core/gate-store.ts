import fs from "node:fs";
import { ACTIVE_COMPLETION_GATE_FILE, gateStorePath, legacyGateStorePath, qualityStorePath } from "./meta.js";
import type { GateResult } from "./types.js";
import { atomicWriteFile, readJsonFile } from "./filesystem.js";

export function writeGateResult(root: string, result: GateResult): void {
  const artifact = result.mode === "full" && !result.fast ? "full" : "changed";
  const target = gateStorePath(root, artifact);
  atomicWriteFile(target, JSON.stringify(result, null, 2));
}

export function writeActiveGateRun(root: string, runId: string, result: GateResult): void {
  if (result.mode !== "full") return;
  const target = qualityStorePath(root, ACTIVE_COMPLETION_GATE_FILE);
  atomicWriteFile(target, JSON.stringify({ schemaVersion: 1, runId, result }, null, 2));
}

export function clearActiveGateRun(root: string, runId: string): void {
  const target = qualityStorePath(root, ACTIVE_COMPLETION_GATE_FILE);
  try {
    const current = JSON.parse(fs.readFileSync(target, "utf8")) as { runId?: string };
    if (current.runId === runId) fs.unlinkSync(target);
  } catch {}
}

export function readGateResult(root: string, mode: "changed" | "full" = "full"): GateResult | null {
  return readJsonFile<GateResult>(gateStorePath(root, mode));
}

export function readLegacyGateResult(root: string): unknown | null {
  return readJsonFile(legacyGateStorePath(root));
}
