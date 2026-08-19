export type AgentKind = "orchestrator" | "sub-agent" | "security";

export interface AgentDef {
  kind: AgentKind;
  name: string;
  description: string;
  prompt: string;
  path: string;
}

export interface RuleDef {
  name: string;
  description: string;
  content: string;
  path: string;
  domain: "language" | "security";
  language?: string;
}

export interface SkillDef {
  name: string;
  description: string;
  instructions: string;
  path: string;
}
