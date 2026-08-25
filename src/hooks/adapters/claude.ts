import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";
import { candidateCompleteEvent, dirtyEvent, permissionModeIsPlan, resolveRootFromCwd } from "./common.js";

export const claudeAdapter: VendorAdapter = {
  host: "claude",

  isPlanMode: permissionModeIsPlan,

  resolveRoot(payload: VendorPayload): string {
    return resolveRootFromCwd(payload, "Claude");
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

  getBackgroundTasks(_payload: VendorPayload): string[] | null {
    return null;
  },
};
