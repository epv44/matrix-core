import { resolveConfig } from "../../core/config-resolver.js";
import type { AdapterEvent, VendorPayload } from "./types.js";

export function normalizedMode(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

export function getPayloadValue(payload: VendorPayload, ...keys: string[]): unknown {
  for (const key of keys) if (key in payload) return payload[key];
  return undefined;
}

export function payloadReportsPlanMode(payload: VendorPayload, ...keys: string[]): boolean {
  return normalizedMode(getPayloadValue(payload, ...keys)) === "plan";
}

export function permissionModeIsPlan(payload: VendorPayload): boolean {
  return payloadReportsPlanMode(payload, "permissionMode", "permission_mode");
}

export function resolveRootFromCwd(payload: VendorPayload, host: string): string {
  const cwd = getPayloadValue(payload, "cwd");
  if (typeof cwd === "string" && cwd) return resolveConfig({ cwd }).configRoot;
  throw new Error(`Cannot resolve workspace root from ${host} payload`);
}

export const dirtyEvent = (payload: VendorPayload): AdapterEvent => ({ type: "DIRTY", payload });
export const candidateCompleteEvent = (payload: VendorPayload): AdapterEvent => ({
  type: "CANDIDATE_COMPLETE",
  payload,
});
