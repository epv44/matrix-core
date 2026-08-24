import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSpecialists } from "../../src/agentsmith/registry.js";
import { AGENT_SMITH, smithReviewer } from "../../src/agentsmith/index.js";

const V04_PROMPT_HASHES_WITH_JSON_TRANSPORT = {
  "architecture-reviewer": "1bedc42c0f5a1c2c7297e1da5763b262a91f899f6ce97635021b5c115870b550",
  "bug-hunter": "d75cab86f81466b79657b680242c67840611d54613717ce8ce73178da65f61fc",
  "perf-reviewer": "e6513a22a203ca38814428521276ec20b0e2be8417bff935e2ab3f159d8d7cf9",
  "semantic-reviewer": "9174a66f6bc72e387b1f9551a2ac0c816406498a334ceab78a517284004c49c2",
} as const;

describe("AgentSmith specialist registry", () => {
  it("loads only the four live specialists in stable report order", () => {
    const specialists = loadSpecialists();
    expect(specialists.map((agent) => agent.name)).toEqual([
      "architecture-reviewer",
      "perf-reviewer",
      "bug-hunter",
      "semantic-reviewer",
    ]);
    for (const specialist of specialists) {
      expect(specialist.kind).toBe("sub-agent");
      expect(specialist.prompt.length).toBeGreaterThan(100);
      expect(specialist.prompt).toContain("Return only the requested JSON object");
      expect(specialist.prompt).not.toMatch(/YAML/i);
    }
  });

  it("pins the v0.4 specialist language with only JSON transport normalization", () => {
    for (const specialist of loadSpecialists()) {
      const contents = fs.readFileSync(new URL(`../../src/agentsmith/${specialist.path}`, import.meta.url));
      const hash = crypto.createHash("sha256").update(contents).digest("hex");
      expect(hash, specialist.name).toBe(V04_PROMPT_HASHES_WITH_JSON_TRANSPORT[specialist.name]);
    }
  });

  it("registers the runtime reviewer", () => {
    expect(smithReviewer.name).toBe(AGENT_SMITH);
  });
});
