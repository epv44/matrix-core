import type { SpecialistReviewerId } from "../core/types.js";

export type AgentKind = "sub-agent";

export interface AgentDef {
  kind: AgentKind;
  name: SpecialistReviewerId;
  description: string;
  prompt: string;
  path: string;
}
