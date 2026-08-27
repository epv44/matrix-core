import { loadDoc, type AssetDoc } from "./loader.js";
import type { AgentDef } from "./types.js";
import type { SpecialistReviewerId } from "../core/types.js";

const SPECIALIST_FILES: ReadonlyArray<{ file: string; name: SpecialistReviewerId }> = [
  { file: "agents/sub-agents/architecture-reviewer.md", name: "architecture-reviewer" },
  { file: "agents/sub-agents/perf-reviewer.md", name: "perf-reviewer" },
  { file: "agents/sub-agents/bug-hunter.md", name: "bug-hunter" },
  { file: "agents/sub-agents/semantic-reviewer.md", name: "semantic-reviewer" },
];

function toAgentDef(doc: AssetDoc, file: string, expectedName: SpecialistReviewerId): AgentDef {
  if (doc.name !== expectedName) throw new Error(`Specialist asset ${file} declares unexpected name ${doc.name}`);
  return { kind: "sub-agent", name: expectedName, description: doc.description, prompt: doc.content, path: file };
}

export function loadSpecialists(root?: string): AgentDef[] {
  return SPECIALIST_FILES.map(({ file, name }) => toAgentDef(loadDoc(file, name, root), file, name));
}

export function loadAgent(name: SpecialistReviewerId, root?: string): AgentDef | undefined {
  return loadSpecialists(root).find((agent) => agent.name === name);
}
