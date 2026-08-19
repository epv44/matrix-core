import { loadDoc, type AssetDoc } from "./loader.js";
import type { AgentDef, RuleDef, SkillDef } from "./types.js";

const SUB_AGENT_FILES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "agents/sub-agents/architecture-reviewer.md", name: "architecture-reviewer" },
  { file: "agents/sub-agents/perf-reviewer.md", name: "perf-reviewer" },
  { file: "agents/sub-agents/bug-hunter.md", name: "bug-hunter" },
  { file: "agents/sub-agents/semantic-reviewer.md", name: "semantic-reviewer" },
];

const SECURITY_FILES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "agents/security/threat-modeler.md", name: "threat-modeler" },
  { file: "agents/security/verifier.md", name: "verifier" },
  { file: "agents/security/secrets.md", name: "secrets" },
  { file: "agents/security/researcher.md", name: "researcher" },
  { file: "agents/security/inventory.md", name: "inventory" },
];

const LANGUAGE_RULES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "rules/languages/python.md", name: "python" },
  { file: "rules/languages/typescript.md", name: "typescript" },
  { file: "rules/languages/go.md", name: "go" },
  { file: "rules/languages/rust.md", name: "rust" },
];

const SKILL_FILES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "skills/autofix/SKILL.md", name: "autofix" },
  { file: "skills/peel-the-onion/SKILL.md", name: "peel-the-onion" },
  { file: "skills/review-code/SKILL.md", name: "review-code" },
];

function toAgentDef(doc: AssetDoc, file: string, kind: AgentDef["kind"]): AgentDef {
  return { kind, name: doc.name, description: doc.description, prompt: doc.content, path: file };
}

function toRuleDef(doc: AssetDoc, file: string, domain: RuleDef["domain"], language?: string): RuleDef {
  return { name: doc.name, description: doc.description, content: doc.content, path: file, domain, language };
}

function toSkillDef(doc: AssetDoc, file: string): SkillDef {
  return { name: doc.name, description: doc.description, instructions: doc.content, path: file };
}

export function loadOrchestrator(root?: string): AgentDef {
  return toAgentDef(loadDoc("agents/agent-smith.md", "agent-smith", root), "agents/agent-smith.md", "orchestrator");
}

export function loadSubAgents(root?: string): AgentDef[] {
  return SUB_AGENT_FILES.map(({ file, name }) => toAgentDef(loadDoc(file, name, root), file, "sub-agent"));
}

export function loadSecurityAgents(root?: string): AgentDef[] {
  return SECURITY_FILES.map(({ file, name }) => toAgentDef(loadDoc(file, name, root), file, "security"));
}

export function loadAgents(root?: string): AgentDef[] {
  return [loadOrchestrator(root), ...loadSubAgents(root), ...loadSecurityAgents(root)];
}

export function loadAgent(name: string): AgentDef | undefined {
  return loadAgents().find((agent) => agent.name === name);
}

export function loadRules(opts?: { language?: string; domain?: "language" | "security"; root?: string }): RuleDef[] {
  const rules: RuleDef[] = LANGUAGE_RULES.map(({ file, name }) =>
    toRuleDef(loadDoc(file, name, opts?.root), file, "language", name),
  );
  rules.push(
    toRuleDef(loadDoc("rules/security/review.md", "security", opts?.root), "rules/security/review.md", "security"),
  );
  return rules.filter((rule) => {
    if (opts?.domain && rule.domain !== opts.domain) return false;
    if (opts?.language && rule.language !== opts.language) return false;
    return true;
  });
}

export function loadRule(name: string): RuleDef | undefined {
  return loadRules().find((rule) => rule.name === name);
}

export function loadSkills(root?: string): SkillDef[] {
  return SKILL_FILES.map(({ file, name }) => toSkillDef(loadDoc(file, name, root), file));
}

export function loadSkill(name: string): SkillDef | undefined {
  return loadSkills().find((skill) => skill.name === name);
}
