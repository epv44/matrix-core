import { resolveConfig } from "../../core/config-resolver.js";
import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { candidateCompleteEvent, dirtyEvent, getPayloadValue, permissionModeIsPlan } from "./common.js";

export const clineAdapter: VendorAdapter = {
  host: "cline",

  isPlanMode: permissionModeIsPlan,

  resolveRoot(payload: VendorPayload): string {
    let candidate: string | undefined;
    const roots = getPayloadValue(payload, "workspaceRoots", "workspace_roots");
    if (Array.isArray(roots)) {
      const validRoots = roots.filter((root): root is string => typeof root === "string");
      const cwd = getPayloadValue(payload, "cwd");
      if (validRoots.length === 1) candidate = validRoots[0];
      else if (typeof cwd === "string") {
        const normalizedCwd = fs.realpathSync(path.resolve(cwd));
        const matching = validRoots.filter((root) => {
          try {
            const normalizedRoot = fs.realpathSync(path.resolve(root));
            return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}${path.sep}`);
          } catch {
            return false;
          }
        });
        if (matching.length === 1) candidate = matching[0];
        else if (matching.length > 1) throw new Error("Cline payload maps cwd to multiple workspace roots");
      }
    }
    if (!candidate) candidate = getPayloadValue(payload, "cwd") as string | undefined;
    if (!candidate) throw new Error("Cannot resolve workspace root from Cline payload");
    return resolveConfig({ cwd: candidate }).configRoot;
  },

  onToolCall(payload: VendorPayload): AdapterEvent | null {
    const tool = getPayloadValue(payload, "tool") as string | undefined;
    if (tool && ["write_to_file", "replace_in_file", "apply_diff"].includes(tool)) {
      return dirtyEvent(payload);
    }
    return null;
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
