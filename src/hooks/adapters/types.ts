export interface VendorPayload {
  host: "cline" | "codex" | "claude";
  turnId?: string;
  workspaceRoots?: string[];
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
  collaborationModeKind?: string;
  backgroundTasks?: Array<{ id: string; command: string; status: string }>;
  tool?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AdapterEvent {
  type: "DIRTY" | "CANDIDATE_COMPLETE" | "VALIDATION_COMPLETE" | "PLAN_MODE";
  payload: VendorPayload;
}

export interface VendorAdapter {
  host: "cline" | "codex" | "claude";
  isPlanMode(payload: VendorPayload): boolean;
  resolveRoot(payload: VendorPayload): string;
  onToolCall(payload: VendorPayload): AdapterEvent | null;
  onTurnStart(payload: VendorPayload): AdapterEvent | null;
  onTurnEnd(payload: VendorPayload): AdapterEvent | null;
  getBackgroundTasks(payload: VendorPayload): string[] | null;
}
