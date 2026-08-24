import { resolveConfig } from "../../core/config-resolver.js";
import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";

function normalizedMode(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function getPayloadValue(payload: VendorPayload, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in payload) return payload[key];
  }
  return undefined;
}

export const claudeAdapter: VendorAdapter = {
  host: "claude",

  isPlanMode(payload: VendorPayload): boolean {
    if (normalizedMode(getPayloadValue(payload, "permissionMode", "permission_mode")) === "plan") return true;
    return false;
  },

  resolveRoot(payload: VendorPayload): string {
    const cwd = getPayloadValue(payload, "cwd") as string | undefined;
    if (cwd) return resolveConfig({ cwd }).configRoot;
    throw new Error("Cannot resolve workspace root from Claude payload");
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

  getBackgroundTasks(_payload: VendorPayload): string[] | null {
    return null;
  },
};
