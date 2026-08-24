import { clineAdapter } from "./cline.js";
import { codexAdapter } from "./codex.js";
import { claudeAdapter } from "./claude.js";
import type { VendorAdapter, VendorPayload, AdapterEvent } from "./types.js";

const adapters: Record<string, VendorAdapter> = {
  cline: clineAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
};

export function getAdapter(host: string): VendorAdapter | null {
  return adapters[host] ?? null;
}

export function listAdapters(): VendorAdapter[] {
  return Object.values(adapters);
}

export function processEvent(host: string, payload: VendorPayload): AdapterEvent[] {
  const adapter = getAdapter(host);
  if (!adapter) return [];

  const events: AdapterEvent[] = [];

  if (adapter.isPlanMode(payload)) {
    events.push({ type: "PLAN_MODE", payload });
    return events;
  }

  const dirty = adapter.onToolCall(payload);
  if (dirty) events.push(dirty);

  return events;
}

export function processTurnEnd(host: string, payload: VendorPayload): AdapterEvent | null {
  const adapter = getAdapter(host);
  if (!adapter) return null;
  if (adapter.isPlanMode(payload)) return { type: "PLAN_MODE", payload };
  return adapter.onTurnEnd(payload);
}

export function processTurnStart(host: string, payload: VendorPayload): AdapterEvent | null {
  const adapter = getAdapter(host);
  if (!adapter) return null;
  if (adapter.isPlanMode(payload)) return { type: "PLAN_MODE", payload };
  return adapter.onTurnStart(payload);
}

export function getBackgroundTasks(host: string, payload: VendorPayload): string[] | null {
  const adapter = getAdapter(host);
  if (!adapter) return null;
  return adapter.getBackgroundTasks(payload);
}

export function resolveRoot(host: string, payload: VendorPayload): string {
  const adapter = getAdapter(host);
  if (!adapter) throw new Error(`Unknown host: ${host}`);
  return adapter.resolveRoot(payload);
}

export { resolveRoot as resolveHookRoot };
