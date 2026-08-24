import { resolveConfig } from "../../core/config-resolver.js";
import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";
import fs from "node:fs";

function normalizedMode(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function getPayloadValue(payload: VendorPayload, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in payload) return payload[key];
  }
  return undefined;
}

function codexTranscriptReportsPlan(payload: VendorPayload): boolean {
  const transcriptPath = getPayloadValue(payload, "transcriptPath", "transcript_path") as string | undefined;
  const turnId = getPayloadValue(payload, "turnId", "turn_id") as string | undefined;
  if (!transcriptPath || !turnId || typeof transcriptPath !== "string" || typeof turnId !== "string") return false;

  try {
    if (!fs.existsSync(transcriptPath)) return false;
    const content = fs.readFileSync(transcriptPath, "utf8");
    let foundPlan = false;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== "event_msg" || !record.payload) continue;
        const eventPayload = record.payload as Record<string, unknown>;
        if (eventPayload.type !== "task_started" || eventPayload.turn_id !== turnId) continue;
        const collabMode = eventPayload.collaboration_mode_kind;
        if (normalizedMode(collabMode) === "plan") {
          foundPlan = true;
        } else {
          foundPlan = false;
        }
      } catch {}
    }
    return foundPlan;
  } catch {}
  return false;
}

export const codexAdapter: VendorAdapter = {
  host: "codex",

  isPlanMode(payload: VendorPayload): boolean {
    if (normalizedMode(getPayloadValue(payload, "permissionMode", "permission_mode")) === "plan") return true;
    if (normalizedMode(getPayloadValue(payload, "collaborationModeKind", "collaboration_mode_kind")) === "plan")
      return true;
    return codexTranscriptReportsPlan(payload);
  },

  resolveRoot(payload: VendorPayload): string {
    const cwd = getPayloadValue(payload, "cwd") as string | undefined;
    if (cwd) return resolveConfig({ cwd }).configRoot;
    throw new Error("Cannot resolve workspace root from Codex payload");
  },

  onToolCall(payload: VendorPayload): AdapterEvent | null {
    return { type: "DIRTY", payload };
  },

  onTurnStart(payload: VendorPayload): AdapterEvent | null {
    return { type: "DIRTY", payload };
  },

  onTurnEnd(payload: VendorPayload): AdapterEvent | null {
    return { type: "CANDIDATE_COMPLETE", payload };
  },

  getBackgroundTasks(payload: VendorPayload): string[] | null {
    const tasks = getPayloadValue(payload, "backgroundTasks") as
      Array<{ id: string; command: string; status: string }> | undefined;
    if (!tasks) return null;
    return tasks.filter((t) => t.status === "running").map((t) => t.command);
  },
};
