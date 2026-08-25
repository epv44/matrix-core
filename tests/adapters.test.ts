import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBackgroundTasks,
  processEvent,
  processTurnEnd,
  processTurnStart,
  resolveRoot,
} from "../src/hooks/adapters/index.js";
import type { VendorPayload } from "../src/hooks/adapters/types.js";

function payload(host: VendorPayload["host"], values: Partial<VendorPayload> = {}): VendorPayload {
  return { host, ...values };
}

describe("vendor adapters", () => {
  it.each(["claude", "cline", "codex"] as const)("normalizes plan-mode aliases for %s", (host) => {
    expect(processEvent(host, payload(host, { permission_mode: " PLAN " } as Partial<VendorPayload>))).toMatchObject([
      { type: "PLAN_MODE" },
    ]);
  });

  it("shares lifecycle events while retaining host-specific behavior", () => {
    expect(processTurnStart("claude", payload("claude"))).toMatchObject({ type: "DIRTY" });
    expect(processTurnEnd("cline", payload("cline"))).toMatchObject({ type: "CANDIDATE_COMPLETE" });
    expect(
      getBackgroundTasks(
        "codex",
        payload("codex", {
          backgroundTasks: [
            { id: "1", command: "npm test", status: "running" },
            { id: "2", command: "npm build", status: "complete" },
          ],
        }),
      ),
    ).toEqual(["npm test"]);
  });

  it("resolves cwd and Cline workspace-root payloads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-adapter-"));
    expect(resolveRoot("claude", payload("claude", { cwd: root }))).toBe(fs.realpathSync(root));
    expect(resolveRoot("cline", payload("cline", { cwd: root, workspaceRoots: [root] }))).toBe(fs.realpathSync(root));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
