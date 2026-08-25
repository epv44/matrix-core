#!/usr/bin/env node
import { TurnGate } from "../core/turn-gate.js";
import {
  getAdapter,
  processTurnEnd,
  resolveRoot,
  resolveRoot as resolveHookRoot,
  getBackgroundTasks,
} from "./adapters/index.js";
import { recordEngineRuntime } from "../core/runtime.js";
import { turnStore } from "../core/turn-store.js";
import { isMainModule } from "../core/process.js";

export type HookHost = "cline" | "codex" | "claude";

export { resolveHookRoot };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function hasValidationRelevantBackgroundTasks(tasks: string[] | null): boolean {
  if (!tasks || tasks.length === 0) return false;
  const relevant = ["test", "build", "lint", "typecheck", "generate", "migrate"];
  return tasks.some((t) => relevant.some((r) => t.toLowerCase().includes(r)));
}

export async function renderHookDecision(host: HookHost, payload: Record<string, unknown>) {
  const adapter = getAdapter(host);
  if (!adapter) {
    return host === "cline"
      ? { cancel: true, errorMessage: `Unknown host: ${host}` }
      : { decision: "block", reason: `Unknown host: ${host}` };
  }

  if (adapter.isPlanMode(payload as any)) {
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};
  }

  let root: string;
  try {
    root = resolveRoot(host, payload as any);
    recordEngineRuntime(root, "hook");
  } catch (error) {
    const reason = `MatrixCore completion hook failed: ${error instanceof Error ? error.message : String(error)}`;
    return host === "cline"
      ? { cancel: true, contextModification: "", errorMessage: reason }
      : { decision: "block", reason };
  }

  const turnGate = new TurnGate(root);

  // Handle markDirty event (for tool calls, turn_start, etc. - doesn't block)
  if (payload.event === "markDirty") {
    turnGate.onDirty(host, getTurnId(payload));
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};
  }

  const bgTasks = getBackgroundTasks(host, payload as any);
  if (bgTasks && hasValidationRelevantBackgroundTasks(bgTasks)) {
    const reason = `Validation-relevant background tasks running: ${bgTasks.join(", ")}. Wait for completion.`;
    return host === "cline"
      ? { cancel: true, contextModification: "", errorMessage: reason }
      : { decision: "block", reason };
  }

  const turnEndEvent = processTurnEnd(host, payload as any);
  if (!turnEndEvent) {
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};
  }

  if (turnEndEvent.type === "PLAN_MODE") {
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};
  }

  let result;
  try {
    result = await turnGate.onCandidateComplete(host, getTurnId(payload));
  } catch (error) {
    turnStore.failed(root, error instanceof Error ? error.message : String(error), host, getTurnId(payload));
    const reason = `MatrixCore validation infrastructure failed: ${error instanceof Error ? error.message : String(error)}`;
    return host === "cline"
      ? { cancel: true, contextModification: reason, errorMessage: reason }
      : { decision: "error", reason };
  }

  if (result.decision === "allow") {
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};
  }

  if (result.decision === "error") {
    return host === "cline"
      ? { cancel: true, contextModification: result.reason, errorMessage: result.reason }
      : { decision: "error", reason: result.reason };
  }

  return host === "cline"
    ? { cancel: true, contextModification: result.reason, errorMessage: result.reason }
    : { decision: "block", reason: result.reason };
}

function getTurnId(payload: Record<string, unknown>): string | undefined {
  const value = payload.turn_id ?? payload.turnId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const host = process.argv[2] as HookHost;
    const reason = `MatrixCore hook error: ${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(
      `${JSON.stringify(host === "cline" ? { cancel: true, errorMessage: reason } : { decision: "block", reason })}\n`,
    );
    process.exitCode = 0;
  });
}

async function main() {
  const host = process.argv[2] as HookHost;
  const event = process.argv[3] || "turn_end";
  if (!(["cline", "codex", "claude"] as string[]).includes(host)) {
    throw new Error("Usage: matrixcore-hook <cline|codex|claude> <event>");
  }
  const raw = await readStdin();
  const payload = JSON.parse(raw || "{}") as Record<string, unknown>;
  payload.event = event;
  const decision = await renderHookDecision(host, payload);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
