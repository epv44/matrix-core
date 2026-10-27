import { describe, expect, it } from "vitest";
import {
  BRANCH_ANALYSIS_SYSTEM_PROMPT,
  generateWorkItemCandidate,
  parseCandidateConclusion,
  verifyCandidateWithModel,
} from "../../src/agentsmith/candidate-generation.js";
import { buildTaskEvidenceSelectors } from "../../src/agentsmith/evidence-locators.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ModelProfile } from "../../src/core/types.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

const profile: ModelProfile = {
  id: "candidate",
  provider: "ollama",
  model: "qwen",
  contextTokens: 8192,
  reviewCapability: "small",
  requestedOutputTokens: 1024,
  safetyReserveTokens: 1000,
  tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
  inference: { temperature: 0, thinking: false, timeoutMs: 300_000 },
};

const symbol = {
  file: "src/a.ts",
  provider: "typescript-compiler",
  kind: "function" as const,
  name: "value",
  qualifiedName: "value",
  startLine: 1,
  endLine: 1,
  contentHash: "a",
};

const item: ReviewWorkItem = {
  id: "local:value",
  kind: "local",
  primarySymbols: [symbol],
  relatedSymbols: [],
  graphEdges: [],
  rules: [],
  code: [
    {
      id: "code",
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      symbol: "value",
      content: "export function value() { return 1; }",
      changed: true,
      score: 100,
      reason: "changed",
      estimatedTokens: 20,
    },
  ],
  estimatedTokens: 100,
};

describe("candidate structured output", () => {
  it("projects a host-referenced witness into deterministic candidate semantics", async () => {
    const related = {
      ...symbol,
      file: "src/auth.ts",
      kind: "interface" as const,
      name: "Session",
      qualifiedName: "Session",
      contentHash: "session",
    };
    const witnessItem: ReviewWorkItem = {
      ...item,
      kind: "interaction",
      relatedSymbols: [related],
      graphEdges: [{
        source: "src/a.ts:value",
        target: "src/auth.ts:Session",
        targetText: "Session",
        kind: "reads-type",
        confidence: "exact",
        provider: "typescript-compiler",
        sourceSymbol: symbol,
        targetSymbol: related,
      }],
      rules: [{
        id: "security.authorization-boundary",
        text: "Only administrators may cross this authorization boundary.",
        estimatedTokens: 12,
        categories: ["security"],
        severity: "critical",
      }],
      controlFlowWitnesses: [{
        version: "control-flow-witness/v1",
        witnessId: "a".repeat(64),
        witnessKey: "value.guard-1.state-1",
        snapshotId: "snapshot-a",
        ownerSymbol: { file: "src/a.ts", qualifiedName: "value", startLine: 1, endLine: 1 },
        file: "src/a.ts",
        startLine: 1,
        endLine: 1,
        previousGuard: "!session || role !== \"admin\"",
        currentGuard: "!session && role !== \"admin\"",
        operatorTokens: ["!", "&&", "!=="],
        state: 'session present, role = "member"',
        previousOutcome: "blocked",
        currentOutcome: "passes",
      }],
    };
    const calls: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(input);
        return {
          raw: JSON.stringify({ state: "finding", candidates: [{
            file: "src/a.ts",
            line: 1,
            endLine: 1,
            witnessKey: "value.guard-1.state-1",
            basisRuleId: "security.authorization-boundary",
            impact: "a member can execute the protected operation",
            confidence: 0.9,
          }] }),
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const selectors = buildTaskEvidenceSelectors({ snapshotId: "snapshot-a", workItem: witnessItem });
    const result = await generateWorkItemCandidate({
      item: witnessItem,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      allowedEvidenceSelectors: selectors,
      arm: "host-referenced-witness",
    });
    expect(calls[0]?.candidateArm).toBe("host-referenced-witness");
    expect(calls[0]?.allowedWitnessKeys).toEqual(["value.guard-1.state-1"]);
    expect(calls[0]?.prompt).not.toContain("a".repeat(64));
    expect(result.contract).toMatchObject({
      requestedCandidateArm: "host-referenced-witness",
      effectiveCandidateArm: "host-referenced-witness",
    });
    expect(result.candidates[0]).toMatchObject({
      file: "src/a.ts",
      line: 1,
      severity: "critical",
      category: "security",
      primarySymbol: "value",
      ruleId: "security.authorization-boundary",
      witness: { witnessId: "a".repeat(64), witnessKey: "value.guard-1.state-1" },
    });
    expect(result.candidates[0]?.description).toContain('Trigger: session present, role = "member"');
    expect(result.candidates[0]?.description).toContain('!session && role !== "admin"');
    expect(result.candidates[0]?.evidenceRequests.map((request) => request.kind)).toEqual(["type", "implementation"]);
  });

  it("fails closed when a witness candidate changes its host-owned reference", async () => {
    const witnessItem: ReviewWorkItem = {
      ...item,
      rules: [{ id: "security.visible", text: "Visible rule", estimatedTokens: 1, categories: ["security"], severity: "critical" }],
      controlFlowWitnesses: [{
        version: "control-flow-witness/v1", witnessId: "b".repeat(64), witnessKey: "value.guard-1.state-1",
        snapshotId: "snapshot-a", ownerSymbol: { file: "src/a.ts", qualifiedName: "value", startLine: 1, endLine: 1 },
        file: "src/a.ts", startLine: 1, endLine: 1, previousGuard: "a || b", currentGuard: "a && b",
        operatorTokens: ["&&"], state: "a = false", previousOutcome: "blocked", currentOutcome: "passes",
      }],
    };
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => ({
        raw: JSON.stringify({ state: "finding", candidates: [{
          file: "src/a.ts", line: 1, witnessKey: "invented.guard-9.state-9",
          basisRuleId: "security.visible", impact: "bad", confidence: 1,
        }] }),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    await expect(generateWorkItemCandidate({
      item: witnessItem, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1,
      arm: "host-referenced-witness", inferenceMode: "thinking-structured",
    })).rejects.toThrow(/unknown control-flow witness/);
  });

  it("falls back to the rule-bound contract without changing its prompt or wire inputs", async () => {
    const ruleBoundItem: ReviewWorkItem = {
      ...item,
      rules: [{ id: "security.visible", text: "Visible rule", estimatedTokens: 1, categories: ["security"], severity: "critical" }],
    };
    const calls: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(input);
        return { raw: JSON.stringify({ state: "no_finding", candidates: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const fallback = await generateWorkItemCandidate({
      item: ruleBoundItem, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1,
      arm: "host-referenced-witness",
    });
    await generateWorkItemCandidate({
      item: ruleBoundItem, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1,
      arm: "rule-bound-classification",
    });
    expect(calls[0]).toMatchObject({ candidateArm: "rule-bound-classification", allowedRuleIds: ["security.visible"] });
    expect(calls[0]?.allowedWitnessKeys).toBeUndefined();
    expect(calls[0]?.prompt).toBe(calls[1]?.prompt);
    expect(calls[0]?.systemPrompt).toBe(calls[1]?.systemPrompt);
    expect(fallback.contract).toMatchObject({
      requestedCandidateArm: "host-referenced-witness",
      effectiveCandidateArm: "rule-bound-classification",
    });
  });

  it("derives declared classification only from the candidate's visible basis rule", async () => {
    const ruleBoundItem: ReviewWorkItem = {
      ...item,
      rules: [{
        id: "security.authorization-boundary",
        text: "Require an executable authorization bypass.",
        estimatedTokens: 12,
        categories: ["security"],
        severity: "critical",
      }],
    };
    const calls: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(input);
        return {
          raw: JSON.stringify({ state: "finding", candidates: [{
            file: "src/a.ts", line: 1, severity: "high", category: "contract",
            basisRuleId: "security.authorization-boundary",
            trigger: "member session reaches deletion", invariant: "only admins may delete", impact: "unauthorized deletion", confidence: 1,
          }] }),
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item: ruleBoundItem,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      arm: "rule-bound-classification",
    });
    expect(calls[0]?.allowedRuleIds).toEqual(["security.authorization-boundary"]);
    expect(result.candidates[0]).toMatchObject({
      category: "security",
      severity: "critical",
      ruleId: "security.authorization-boundary",
      classification: { basisRuleId: "security.authorization-boundary", categorySource: "rule", severitySource: "rule" },
    });
  });

  it("rejects a rule-bound candidate that names a non-visible rule", async () => {
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => ({
        raw: JSON.stringify({ state: "finding", candidates: [{
          file: "src/a.ts", line: 1, severity: "critical", category: "security",
          basisRuleId: "security.not-visible",
          trigger: "x", invariant: "y", impact: "z", confidence: 1,
        }] }),
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    };
    await expect(generateWorkItemCandidate({
      item: { ...item, rules: [{ id: "security.visible", text: "visible", estimatedTokens: 1, categories: ["security"], severity: "critical" }] },
      profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1, arm: "rule-bound-classification", inferenceMode: "thinking-structured",
    })).rejects.toThrow(/basisRuleId must name one visible/);
  });

  it("maps the simplified semantic contract to host-owned fields", async () => {
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => ({
        raw: JSON.stringify({
          state: "finding",
          candidates: [{
            file: "src/a.ts",
            line: 1,
            severity: "high",
            category: "correctness",
            trigger: "input is invalid",
            invariant: "return must be valid",
            impact: "caller receives a bad value",
            confidence: 0.9,
          }],
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      allowedEvidenceSelectors: buildTaskEvidenceSelectors({ snapshotId: "snapshot-a", workItem: item }),
    });
    expect(result.candidateState).toBe("finding");
    expect(result.candidates[0]).toMatchObject({
      title: "correctness defect: return must be valid",
      primarySymbol: "value",
      description: "Trigger: input is invalid Invariant: return must be valid Impact: caller receives a bad value",
    });
    expect(result.candidates[0]?.evidenceRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "implementation" })]),
    );
  });

  it("uses one non-repairing provider call for thinking-structured", async () => {
    const calls: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(input);
        return {
          raw: JSON.stringify({ state: "finding", candidates: [{
            file: "src/a.ts",
            line: 1,
            severity: "high",
            category: "correctness",
            trigger: "input is invalid",
            invariant: "return must be valid",
            impact: "caller receives a bad value",
            confidence: 0.9,
          }] }),
          thinking: "reasoning trace",
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      inferenceMode: "thinking-structured",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inferenceMode).toBe("thinking-structured");
    expect(result.thinking).toBe("reasoning trace");
    expect(result.candidateState).toBe("finding");
  });

  it("accepts only task-scoped semantic selectors on the small-model path", async () => {
    const selectors = buildTaskEvidenceSelectors({ snapshotId: "snapshot-a", workItem: item });
    const definitionSelector = selectors.find((selector) => selector.key.endsWith(".definition"))!;
    expect(definitionSelector.key).toContain("primary-1");
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => ({
        raw: JSON.stringify({ c: [{ f: "src/a.ts", l: 1, s: "high", k: "correctness", t: "Bad return", d: "The return is wrong.", q: 0.9, e: [{ selector: definitionSelector.key, r: "confirm implementation" }] }] }),
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      allowedEvidenceSelectors: selectors,
    });
    expect(result.candidates[0]?.evidenceRequests).toEqual([
      expect.objectContaining({ kind: "definition", symbol: "value", pathHint: "src/a.ts" }),
      expect.objectContaining({ kind: "implementation", symbol: "value", pathHint: "src/a.ts" }),
    ]);
  });

  it("uses a deterministic bounded question and concrete claim instructions", async () => {
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        prompts.push(input.prompt);
        return {
          raw: JSON.stringify({
            c: [{ f: "src/a.ts", l: 1, s: "high", k: "correctness", t: "wrong return", d: "Trigger: input is invalid. Invariant: return must be valid. Impact: caller receives a bad value.", q: 0.9, e: [] }],
          }),
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    await generateWorkItemCandidate({ item, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Bounded question: Does the changed implementation contain one concrete executable correctness defect?");
    expect(prompts[0]).toContain("trigger, invariant, impact, and confidence");
    expect(prompts[0]).toContain("The host derives the title");
  });

  it("adds branch analysis instructions without changing the candidate prompt contract", async () => {
    const systems: Array<string | undefined> = [];
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        systems.push(input.systemPrompt);
        prompts.push(input.prompt);
        return {
          raw: JSON.stringify({ state: "no_finding", candidates: [] }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    await generateWorkItemCandidate({ item, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1 });
    await generateWorkItemCandidate({ item, profile, provider, allowedFiles: ["src/a.ts"], maxCandidates: 1, promptVariant: "branch-analysis-v1" });
    expect(systems).toEqual([undefined, BRANCH_ANALYSIS_SYSTEM_PROMPT]);
    expect(prompts[0]).toBe(prompts[1]);
    expect(BRANCH_ANALYSIS_SYSTEM_PROMPT).toContain("preserve that failing state in the final candidate");
    expect(BRANCH_ANALYSIS_SYSTEM_PROMPT).toContain("Do not substitute another branch");
  });

  it("renders host-derived control-flow context as context rather than a policy claim", async () => {
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        prompts.push(input.prompt);
        return { raw: JSON.stringify({ state: "no_finding", candidates: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await generateWorkItemCandidate({
      item: { ...item, controlFlowDeltas: [{ file: "src/a.ts", startLine: 1, endLine: 1, state: "value = null", previousOutcome: "blocked", currentOutcome: "passes" }] },
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
    });
    expect(prompts[0]).toContain("Control-flow delta (host-derived; it is not itself a finding or policy rule)");
    expect(prompts[0]).toContain("previous guard blocked; current guard passes");
  });

  it("lets schema-native providers own serialization for thinking-structured branch analysis", async () => {
    const inputs: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        inputs.push(input);
        return {
          raw: JSON.stringify({ state: "no_finding", candidates: [] }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    for (const providerName of ["vllm", "ollama"] as const)
      await generateWorkItemCandidate({
        item,
        profile: { ...profile, provider: providerName },
        provider,
        allowedFiles: ["src/a.ts"],
        maxCandidates: 1,
        inferenceMode: "thinking-structured",
        promptVariant: "branch-analysis-v1",
      });
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.prompt).not.toContain("Return exactly one JSON object");
      expect(input.prompt).toContain("serving API supplies and enforces the response schema");
      expect(input.systemPrompt).not.toBe(BRANCH_ANALYSIS_SYSTEM_PROMPT);
      expect(input.systemPrompt).toContain("provider-defined response");
      expect(input.systemPrompt).toContain("preserve that failing state in the final candidate");
    }
  });

  it("keeps state-scan control intact and applies the generic delta-first paragraph only to its treatment", async () => {
    const inputs: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        inputs.push(input);
        return { raw: JSON.stringify({ state: "no_finding", candidates: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const invoke = (promptVariant: "branch-analysis-state-scan-v2" | "branch-analysis-delta-first-v3") =>
      generateWorkItemCandidate({
        item,
        profile: { ...profile, provider: "vllm" },
        provider,
        allowedFiles: ["src/a.ts"],
        maxCandidates: 1,
        inferenceMode: "thinking-structured",
        promptVariant,
      });

    await invoke("branch-analysis-state-scan-v2");
    await invoke("branch-analysis-delta-first-v3");

    const control = inputs[0]?.systemPrompt ?? "";
    const treatment = inputs[1]?.systemPrompt ?? "";
    expect(control).toContain("Use a compact state scan, not a narrative explanation.");
    expect(control).toContain("For every changed condition with a finite state space, enumerate each relevant state exactly once.");
    expect(control).not.toContain("delta-first compact state scan");
    expect(treatment).toContain("Use a delta-first compact state scan, not a narrative explanation.");
    expect(treatment).toContain("evaluate that state before any other runtime state");
    expect(treatment).toContain("Treat the delta as evidence to evaluate, not proof of a defect");
    expect(treatment).not.toMatch(/member|deleteUser|src\/routes\.ts/);
    expect(inputs[0]?.prompt).toBe(inputs[1]?.prompt);
    expect(inputs[0]?.outputKind).toBe(inputs[1]?.outputKind);
  });


  it("parses and preserves a bounded runtime conclusion through the formatter call", async () => {
    expect(
      parseCandidateConclusion(`analysis\nBEGIN_CONCLUSION\nDECISION: finding\nDECISIVE_RUNTIME_STATE: session = { role: "member" }\nEVALUATION:\nrole = "member"\nshort_circuit = true\nthrows = false\nVIOLATED_RULE: Only admin sessions may delete users.\nDEFECT: Authenticated non-admin sessions bypass the authorization guard.\nEND_CONCLUSION`),
    ).toMatchObject({
      decision: "finding",
      decisiveRuntimeState: 'session = { role: "member" }',
      violatedRule: "Only admin sessions may delete users.",
    });
    const calls: Array<Parameters<ReviewProvider["invoke"]>[0]> = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(input);
        return calls.length === 1
          ? {
              raw: `BEGIN_CONCLUSION\nDECISION: finding\nDECISIVE_RUNTIME_STATE: session = { role: "member" }\nEVALUATION:\nrole = "member"\nshort_circuit = true\nthrows = false\nVIOLATED_RULE: Only admin sessions may delete users.\nDEFECT: Authenticated non-admin sessions bypass the authorization guard.\nEND_CONCLUSION`,
              thinking: "ordinary reasoning",
              usage: { inputTokens: 100, outputTokens: 200 },
              completion: { model: "qwen", done: true, doneReason: "stop", totalDurationNs: 1, loadDurationNs: 1, promptEvalDurationNs: 1, evalDurationNs: 1 },
            }
          : {
              raw: JSON.stringify({
                state: "finding",
                candidates: [{ file: "src/a.ts", line: 1, severity: "critical", category: "security", trigger: "member session bypasses admin guard", invariant: "Only admin sessions may delete users", impact: "member can delete", confidence: 0.9 }],
              }),
              usage: { inputTokens: 50, outputTokens: 50 },
            };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      inferenceMode: "thinking-conclusion-then-structured",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.inferenceMode).toBe("thinking-no-format");
    expect(calls[0]?.systemPrompt).toContain("BEGIN_CONCLUSION");
    expect(calls[1]?.inferenceMode).toBe("structured");
    expect(calls[1]?.systemPrompt).toContain("Do not re-analyze the source");
    expect(calls[1]?.prompt).toContain('DECISIVE_RUNTIME_STATE: session = { role: "member" }');
    expect(calls[1]?.prompt).not.toContain("ordinary reasoning");
    expect(result.candidates[0]?.description).toContain("member session bypasses admin guard");
    expect(result.inputTokens).toBe(150);
    expect(result.outputTokens).toBe(250);
  });

  it("fails closed when the reasoner omits its conclusion block", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        calls += 1;
        return { raw: "analysis without conclusion", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await expect(
      generateWorkItemCandidate({
        item,
        profile,
        provider,
        allowedFiles: ["src/a.ts"],
        maxCandidates: 1,
        inferenceMode: "thinking-conclusion-then-structured",
      }),
    ).rejects.toThrow(/conclusion/);
    expect(calls).toBe(1);
  });

  it("supports isolated candidate-generation arms without changing call count", async () => {
    const selectors = buildTaskEvidenceSelectors({ snapshotId: "snapshot-a", workItem: item });
    const calls: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls.push(`${input.candidateArm}:${input.outputKind}`);
        return {
          raw: JSON.stringify({
            c: [{ f: "src/a.ts", l: 1, s: "high", k: "correctness", t: "Bad return", d: "Return breaks callers.", q: 0.9, e: [] }],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      allowedEvidenceSelectors: selectors,
      arm: "deterministic-evidence",
    });
    expect(calls).toEqual(["deterministic-evidence:candidates"]);
    expect(result.candidates[0]?.evidenceRequests).toHaveLength(2);

    const metadata = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 1,
      allowedEvidenceSelectors: selectors,
      arm: "host-derived-metadata",
    });
    expect(metadata.candidates[0]).toMatchObject({ primarySymbol: "value" });
    expect(metadata.candidates[0]?.title).toMatch(/^correctness defect:/);
    expect(calls).toHaveLength(2);
  });

  it("repairs one schema-invalid response and expands the required evidence locator", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        calls += 1;
        return {
          raw:
            calls === 1
              ? '{"c":[{"f":"src/a.ts","l":1,"s":"high","k":"correctness","t":"Bad return","d":"The return is wrong.","q":109,"e":[]}]}'
              : '{"c":[{"f":"src/a.ts","l":1,"s":"high","k":"correctness","t":"Bad return","d":"The return is wrong.","q":0.9,"e":[{"k":"implementation","v":"value","p":"src/a.ts","r":"confirm return"}]}]}',
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
    });
    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        failureKind: "schema-validation",
        attempt: 1,
        validationIssues: expect.arrayContaining([expect.objectContaining({ path: "c.0.q" })]),
      }),
    ]);
    expect(result.candidates[0].evidenceRequests).toEqual([
      {
        kind: "implementation",
        locatorMode: "symbol",
        symbol: "value",
        pathHint: "src/a.ts",
        query: undefined,
        reason: "confirm return",
      },
    ]);
  });

  it("repairs malformed selector JSON with the explicit selector field", async () => {
    const selectors = buildTaskEvidenceSelectors({ snapshotId: "snapshot-a", workItem: item });
    const definitionSelector = selectors.find((selector) => selector.key.endsWith(".definition"))!;
    let calls = 0;
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        calls += 1;
        prompts.push(input.prompt);
        return {
          raw:
            calls === 1
              ? '{"c":[{"f":"src/a.ts","l":1,"s":"high","k":"correctness","t":"Bad return","d":"The return is wrong.","q":0.9,"e":[{"selector":,"r":"confirm implementation"}]}]}'
              : JSON.stringify({
                  c: [
                    {
                      f: "src/a.ts",
                      l: 1,
                      s: "high",
                      k: "correctness",
                      t: "Bad return",
                      d: "The return is wrong.",
                      q: 0.9,
                      e: [{ selector: definitionSelector.key, r: "confirm implementation" }],
                    },
                  ],
                }),
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      allowedEvidenceSelectors: selectors,
    });
    expect(calls).toBe(2);
    expect(prompts[1]).toContain('exactly this shape: {"selector":"<one exact allowed selector key>","r":"short reason"}');
    expect(prompts[1]).toContain(definitionSelector.key);
    expect(prompts[1]).toContain('use "e":[]');
    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ failureKind: "json-syntax", attempt: 1 }),
    ]);
  });

  it("repairs malformed verifier citations once", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        prompts.push(input.prompt);
        const attempt = calls++;
        return {
          raw:
            attempt === 0
              ? JSON.stringify({ verdict: "rejected", confidence: 0.9, supportingEvidenceIds: ["bogus-id"] })
              : JSON.stringify({ citations: [{ requestId: "request-1", evidenceId: "e-1" }] }),
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const judged = await verifyCandidateWithModel({
      candidate: {
        id: "candidate",
        sourceWorkItemIds: ["local:1"],
        sourceReviewers: [],
        file: "src/a.ts",
        line: 1,
        severity: "medium",
        category: "correctness",
        title: "Candidate",
        description: "Candidate description",
        evidenceRequests: [],
        candidateConfidence: 0.8,
      },
      originatingCode: "return true;",
      evidenceText: "[e-1] src/a.ts:1-1\nreturn true;",
      evidenceIds: ["e-1"],
      requiredEvidenceIdsByRequest: { "request-1": ["e-1"] },
      profile,
      provider,
    });
    expect(calls).toBe(2);
    expect(judged.result).toMatchObject({
      verdict: "rejected",
      supportingEvidenceIds: ["e-1"],
      citationRepairAttempted: true,
      providerInvocations: 2,
    });
    expect(judged.result.diagnostics).toEqual([
      expect.objectContaining({ failureKind: "citation-validation", attempt: 1 }),
    ]);
    expect(judged).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(prompts[1]).toContain("request request-1: choose exactly one of e-1");
    expect(prompts[1]).not.toContain("Previous response");
  });

  it("accepts and normalizes bracket-decorated citations without repair", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        calls++;
        return {
          raw: '{"verdict":"verified","confidence":0.9,"supportingEvidenceIds":["[e-1]"," [e-2] "] }',
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const judged = await verifyCandidateWithModel({
      candidate: {
        id: "candidate",
        sourceWorkItemIds: ["local:1"],
        sourceReviewers: [],
        file: "src/a.ts",
        line: 1,
        severity: "medium",
        category: "correctness",
        title: "Candidate",
        description: "Candidate description",
        evidenceRequests: [],
        candidateConfidence: 0.8,
      },
      originatingCode: "return true;",
      evidenceText: "[e-1] src/a.ts:1-1\nreturn true;",
      evidenceIds: ["e-1", "e-2"],
      requiredEvidenceIdsByRequest: { "request-1": ["e-1"], "request-2": ["e-2"] },
      profile,
      provider,
    });
    expect(calls).toBe(1);
    expect(judged.result).toMatchObject({
      verdict: "verified",
      supportingEvidenceIds: ["e-1", "e-2"],
    });
    expect(judged.result.citationRepairAttempted).toBeUndefined();
  });

  it("downgrades a verifier result when citation repair remains invalid", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        const attempt = calls++;
        return {
          raw:
            attempt === 0
              ? '{"verdict":"verified","confidence":1,"supportingEvidenceIds":["invented"]}'
              : '{"citations":[{"requestId":"verdict-citation","evidenceId":"invented"}]}',
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const judged = await verifyCandidateWithModel({
      candidate: {
        id: "candidate",
        sourceWorkItemIds: ["local:1"],
        sourceReviewers: [],
        file: "src/a.ts",
        line: 1,
        severity: "medium",
        category: "correctness",
        title: "Candidate",
        description: "Candidate description",
        evidenceRequests: [],
        candidateConfidence: 0.8,
      },
      originatingCode: "return true;",
      evidenceText: "[e-1] src/a.ts:1-1\nreturn true;",
      evidenceIds: ["e-1"],
      profile,
      provider,
    });
    expect(calls).toBe(2);
    expect(judged.result).toMatchObject({
      verdict: "insufficient_evidence",
      confidence: 0,
      supportingEvidenceIds: [],
      citationRepairAttempted: true,
    });
    expect(judged.result.diagnostics?.filter((item) => item.failureKind === "citation-validation")).toHaveLength(2);
  });
});
