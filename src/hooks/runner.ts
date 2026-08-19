#!/usr/bin/env node
import { evaluateCompletion } from "../core/status.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../core/config-resolver.js";
import { recordEngineRuntime } from "../core/runtime.js";

export type HookHost = "cline" | "codex" | "claude";

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 4 * 1024 * 1024;

function normalizedMode(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function scanJsonLinesReverse(filePath: string, visit: (value: unknown) => boolean | undefined): boolean | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    let position = fs.fstatSync(fd).size;
    let suffix = Buffer.alloc(0);
    let skippingOversizedLine = false;

    while (position > 0) {
      const length = Math.min(TRANSCRIPT_CHUNK_BYTES, position);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, start);
      const data = suffix.length > 0 ? Buffer.concat([chunk, suffix]) : chunk;
      let lineEnd = data.length;

      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        if (!skippingOversizedLine) {
          const line = data
            .subarray(index + 1, lineEnd)
            .toString("utf8")
            .replace(/\r$/, "");
          if (line) {
            try {
              const result = visit(JSON.parse(line));
              if (result !== undefined) return result;
            } catch {
              // Ignore malformed transcript records and continue looking for the matching turn.
            }
          }
        }
        skippingOversizedLine = false;
        lineEnd = index;
      }

      suffix = data.subarray(0, lineEnd);
      if (suffix.length > MAX_TRANSCRIPT_LINE_BYTES) {
        suffix = Buffer.alloc(0);
        skippingOversizedLine = true;
      }
      position = start;
    }

    if (!skippingOversizedLine && suffix.length > 0) {
      try {
        return visit(JSON.parse(suffix.toString("utf8").replace(/\r$/, "")));
      } catch {
        return undefined;
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

function codexTranscriptReportsPlan(payload: Record<string, unknown>): boolean {
  const transcriptPath = payload.transcript_path;
  const turnId = payload.turn_id;
  if (typeof transcriptPath !== "string" || typeof turnId !== "string") return false;

  return (
    scanJsonLinesReverse(transcriptPath, (record) => {
      if (!record || typeof record !== "object") return undefined;
      const event = record as { type?: unknown; payload?: unknown };
      if (event.type !== "event_msg" || !event.payload || typeof event.payload !== "object") return undefined;
      const eventPayload = event.payload as Record<string, unknown>;
      if (eventPayload.type !== "task_started" || eventPayload.turn_id !== turnId) return undefined;
      return normalizedMode(eventPayload.collaboration_mode_kind) === "plan";
    }) ?? false
  );
}

export function isPlanMode(payload: Record<string, unknown>, host: HookHost = "codex"): boolean {
  const value = payload.permission_mode;
  if (normalizedMode(value) === "plan") return true;
  if (host !== "codex") return false;
  if (normalizedMode(payload.collaboration_mode_kind) === "plan") return true;
  return codexTranscriptReportsPlan(payload);
}

export function resolveHookRoot(host: HookHost, payload: Record<string, unknown>): string {
  let candidate: string | undefined;
  if (host === "cline") {
    const roots = payload.workspaceRoots;
    if (Array.isArray(roots) && typeof roots[0] === "string") candidate = roots[0];
  }
  if (!candidate && typeof payload.cwd === "string") candidate = payload.cwd;
  if (candidate) return resolveConfig({ cwd: candidate }).configRoot;
  throw new Error(`Cannot resolve workspace root from ${host} hook payload`);
}

export function renderHookDecision(host: HookHost, payload: Record<string, unknown>) {
  if (isPlanMode(payload, host))
    return host === "cline" ? { cancel: false, contextModification: "", errorMessage: "" } : {};

  let status;
  try {
    const root = resolveHookRoot(host, payload);
    recordEngineRuntime(root, "hook");
    status = evaluateCompletion(root);
  } catch (error) {
    status = {
      completionAllowed: false,
      reason: `MatrixCore completion hook failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const diagnostics = [
    status.policy?.policyHash ? `policy=${status.policy.policyHash}` : "",
    status.workspaces?.length
      ? `workspaces=${status.workspaces.map((workspace) => `${workspace.id}:${workspace.resolutionHash}`).join(",")}`
      : "",
    status.identity?.recorded
      ? `producer=${status.identity.recorded.engineVersion ?? "unknown"}@${status.identity.recorded.enginePath ?? "unknown"}`
      : "",
    status.runtime ? `hook=${status.runtime.version}@${status.runtime.executablePath}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const reason = `${status.reason ?? "Quality gate blocked completion"}${diagnostics ? ` (${diagnostics})` : ""}`;
  if (host === "cline")
    return status.completionAllowed
      ? { cancel: false, contextModification: "", errorMessage: "" }
      : {
          cancel: true,
          contextModification: reason,
          errorMessage: reason,
        };
  if (status.completionAllowed) return {};
  return { decision: "block", reason };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const host = process.argv[2] as HookHost;
  if (!(["cline", "codex", "claude"] as string[]).includes(host))
    throw new Error("Usage: matrixcore-hook <cline|codex|claude> <event>");
  const raw = await readStdin();
  const payload = JSON.parse(raw || "{}") as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify(renderHookDecision(host, payload))}\n`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMainModule())
  main().catch((error) => {
    const host = process.argv[2] as HookHost;
    const reason = `MatrixCore hook error: ${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(
      `${JSON.stringify(host === "cline" ? { cancel: true, errorMessage: reason } : { decision: "block", reason })}\n`,
    );
    process.exitCode = 0;
  });
