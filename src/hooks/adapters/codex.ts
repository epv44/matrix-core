import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";
import fs from "node:fs";
import {
  candidateCompleteEvent,
  dirtyEvent,
  getPayloadValue,
  normalizedMode,
  payloadReportsPlanMode,
  resolveRootFromCwd,
} from "./common.js";

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
    if (payloadReportsPlanMode(payload, "permissionMode", "permission_mode")) return true;
    if (payloadReportsPlanMode(payload, "collaborationModeKind", "collaboration_mode_kind")) return true;
    return codexTranscriptReportsPlan(payload);
  },

  resolveRoot(payload: VendorPayload): string {
    return resolveRootFromCwd(payload, "Codex");
  },

  onToolCall(payload: VendorPayload): AdapterEvent | null {
    return dirtyEvent(payload);
  },

  onTurnStart(payload: VendorPayload): AdapterEvent | null {
    return dirtyEvent(payload);
  },

  onTurnEnd(payload: VendorPayload): AdapterEvent | null {
    return candidateCompleteEvent(payload);
  },

  getBackgroundTasks(payload: VendorPayload): string[] | null {
    const tasks = getPayloadValue(payload, "backgroundTasks") as
      Array<{ id: string; command: string; status: string }> | undefined;
    if (!tasks) return null;
    return tasks.filter((t) => t.status === "running").map((t) => t.command);
  },
};
