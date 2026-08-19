import { describe, expect, it } from "vitest";
import {
  loadAgent,
  loadAgents,
  loadOrchestrator,
  loadRule,
  loadRules,
  loadSecurityAgents,
  loadSkill,
  loadSkills,
  loadSubAgents,
} from "../../src/agentsmith/registry.js";
import { AGENT_SMITH, smithReviewer } from "../../src/agentsmith/index.js";

describe("AgentSmith registry", () => {
  it("loads the orchestrator", () => {
    const orchestrator = loadOrchestrator();
    expect(orchestrator.kind).toBe("orchestrator");
    expect(orchestrator.name).toBe("agent-smith");
    expect(orchestrator.prompt.length).toBeGreaterThan(200);
  });

  it("loads the four sub-agents in order", () => {
    const agents = loadSubAgents();
    expect(agents.map((a) => a.name)).toEqual([
      "architecture-reviewer",
      "perf-reviewer",
      "bug-hunter",
      "semantic-reviewer",
    ]);
    for (const agent of agents) {
      expect(agent.kind).toBe("sub-agent");
      expect(agent.prompt.length).toBeGreaterThan(100);
    }
  });

  it("loads the five security agents", () => {
    const agents = loadSecurityAgents();
    expect(agents.map((a) => a.name)).toEqual(["threat-modeler", "verifier", "secrets", "researcher", "inventory"]);
    for (const agent of agents) {
      expect(agent.kind).toBe("security");
      expect(agent.prompt.length).toBeGreaterThan(100);
    }
  });

  it("loads all agents and resolves by name", () => {
    expect(loadAgents()).toHaveLength(10);
    expect(loadAgent("bug-hunter")?.kind).toBe("sub-agent");
    expect(loadAgent("missing")).toBeUndefined();
  });

  it("loads language and security rules", () => {
    expect(loadRule("python")?.domain).toBe("language");
    expect(loadRule("go")?.language).toBe("go");
    expect(loadRules({ domain: "security" })).toHaveLength(1);
    expect(loadRules({ language: "typescript" })[0].name).toBe("typescript");
    expect(loadRules({ language: "ruby" })).toHaveLength(0);
    expect(loadRule("missing")).toBeUndefined();
  });

  it("loads the three skills", () => {
    const skills = loadSkills();
    expect(skills.map((s) => s.name).sort()).toEqual(["autofix", "peel-the-onion", "review-code"]);
    const reviewCode = loadSkill("review-code");
    expect(reviewCode?.instructions.length).toBeGreaterThan(100);
    expect(loadSkill("missing")).toBeUndefined();
  });

  it("registers a reviewer under AGENT_SMITH", () => {
    expect(smithReviewer.name).toBe(AGENT_SMITH);
  });
});
