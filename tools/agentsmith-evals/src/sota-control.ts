import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSmithConfigFromPolicy } from "../../../src/core/resolved-policy.js";
import type { AgentSmithConfig } from "../../../src/core/types.js";
import { OpenAIResponsesProvider, reviewOutputSchema } from "../../../src/agentsmith/provider.js";
import { renderEvalHtml } from "./html-report.js";
import { runEvalSuite } from "./suite.js";
import {
  VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT,
  VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT,
  resolveVllmEvalTreatment,
} from "./vllm-treatment.js";
import type { CandidatePromptVariant } from "../../../src/agentsmith/engine-types.js";

const MODEL = "gpt-5.6-luna";
const CASE = "auth-guard-bypass";
const PROMPT_VARIANTS: CandidatePromptVariant[] = [
  "baseline",
  "branch-analysis-v1",
  "branch-analysis-state-scan-v2",
  "branch-analysis-delta-first-v3",
  "branch-analysis-type-outcome-v2",
  "branch-analysis-guard-pass-through-v2",
];

function option(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function openAiDiagnosticConfig(config: AgentSmithConfig): AgentSmithConfig {
  return {
    ...config,
    provider: "openai-responses",
    base_url: "https://api.openai.com/v1",
    model_profiles: config.model_profiles.map((profile) => ({ ...profile, provider: "openai-responses", model: MODEL })),
  };
}

async function main() {
  const root = process.cwd();
  const runName = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(root, option("--output-dir", path.join(".quality", "evals", "sota-controls", CASE, runName))!);
  const repeat = Number(option("--repeat", "3"));
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
  const candidatePromptVariant = option("--candidate-prompt-variant", "branch-analysis-v1") as CandidatePromptVariant;
  if (!PROMPT_VARIANTS.includes(candidatePromptVariant))
    throw new Error(`Invalid --candidate-prompt-variant: ${candidatePromptVariant}`);
  const treatment = ["branch-analysis-state-scan-v2", "branch-analysis-delta-first-v3"].includes(candidatePromptVariant)
    ? VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT
    : VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT;
  const treatmentSettings = resolveVllmEvalTreatment(treatment)!;
  await mkdir(outputDir, { recursive: true });
  const schema = reviewOutputSchema("candidates", ["src/routes.ts"], 2, undefined, "rule-bound-classification", ["security.authorization-boundary", "contract.interface-implementation", "contract.value-provenance", "correctness.control-flow"]);
  if (process.argv.includes("--prepare-subagent")) {
    const source = path.resolve(root, option("--descriptor-source", ".quality/evals/vllm-metal-thinking-4b-rule-bound-classification-r3.json")!);
    const report = JSON.parse(await readFile(source, "utf8"));
    const calls = report.reports?.[0]?.cases?.[0]?.results?.flatMap((result: any) => result.diagnostics?.candidateCalls ?? []) ?? [];
    const call = calls.find((item: any) => item.sourceId?.startsWith("local:") && String(item.prompt).includes("deleteUser"));
    if (!call?.prompt) throw new Error(`No frozen local deleteUser descriptor found in ${source}`);
    await writeFile(path.join(outputDir, "descriptor-bundle.json"), JSON.stringify({
      schemaVersion: 1, fixture: CASE, sourceReport: source, sourceReportSha256: sha256(await readFile(source, "utf8")),
      descriptor: { sourceId: call.sourceId, descriptorFingerprint: call.descriptorFingerprint ?? null, prompt: call.prompt, promptSha256: sha256(call.prompt), schema },
    }, null, 2));
    await writeFile(path.join(outputDir, "codex-subagent-prompt.md"), [
      "# GPT-5.6 Luna capability probe",
      "Use no tools, filesystem, repository, network, or external context. Review only the frozen descriptor below.",
      "Return only one JSON object conforming to the supplied schema. Do not modify files.",
      "",
      "## Frozen descriptor", call.prompt,
      "", "## Required JSON schema", JSON.stringify(schema, null, 2),
    ].join("\n"));
    console.log(JSON.stringify({ outputDir, descriptorBundle: path.join(outputDir, "descriptor-bundle.json"), subagentPrompt: path.join(outputDir, "codex-subagent-prompt.md") }, null, 2));
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the diagnostic Responses API control");
  const config = openAiDiagnosticConfig(agentSmithConfigFromPolicy(true));
  const provider = new OpenAIResponsesProvider({ apiKey, reasoningEffort: "high" });
  const jsonPath = path.join(outputDir, "report.json");
  const suite = await runEvalSuite({
    root,
    suite: "component",
    modelTarget: "small",
    cases: [CASE],
    repeat,
    output: jsonPath,
    label: "diagnostic-only:gpt-5.6-luna-responses",
    provider,
    configTransform: openAiDiagnosticConfig,
    candidateArm: treatmentSettings.candidateArm,
    inferenceMode: treatmentSettings.inferenceMode,
    candidatePromptVariant,
    candidateTemperature: treatmentSettings.candidateTemperature,
    candidateTopP: treatmentSettings.candidateTopP,
    candidateTopK: treatmentSettings.candidateTopK,
    candidateThinkingTokens: treatmentSettings.candidateThinkingTokens,
    timeoutMs: treatmentSettings.timeoutMs,
    thinkingStream: treatmentSettings.thinkingStream,
    controlFlowDelta: treatmentSettings.controlFlowDelta,
    treatment,
  });
  const htmlPath = path.join(outputDir, "report.html");
  await writeFile(htmlPath, renderEvalHtml({ run: suite, suite: suite.suite, baseline: suite.baseline?.definition, comparison: suite.comparison }));
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  const candidateCalls = report.reports?.[0]?.cases?.[0]?.results?.flatMap((result: any) => result.diagnostics?.candidateCalls ?? []) ?? [];
  const descriptorBundle = candidateCalls.map((call: any) => ({
    sourceId: call.sourceId,
    descriptorFingerprint: call.descriptorFingerprint ?? null,
    prompt: call.prompt,
    promptSha256: sha256(String(call.prompt ?? "")),
  }));
  await writeFile(path.join(outputDir, "descriptor-bundle.json"), JSON.stringify({
    schemaVersion: 1,
    purpose: "diagnostic-only Luna descriptor replay; not a production policy or baseline",
    fixture: CASE,
    model: MODEL,
    candidatePromptVariant,
    treatment,
    reasoning: { effort: "high", summary: "auto", rawChainOfThought: "unavailable" },
    descriptors: descriptorBundle,
    schema,
  }, null, 2));
  await writeFile(path.join(outputDir, "codex-subagent-prompt.md"), [
    "# GPT-5.6 Luna capability probe",
    "Use no tools, filesystem, repository, network, or external context. Review only the frozen descriptor below.",
    "Return only the required candidate JSON object. This is diagnostic-only; do not modify files.",
    "",
    ...descriptorBundle.map((item: any) => `## ${item.sourceId}\n\n${item.prompt}`).slice(0, 1),
  ].join("\n"));
  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    purpose: "diagnostic-only; excluded from promotion and baseline comparisons",
    model: MODEL,
    reasoningEffort: "high",
    reasoningSummary: "auto",
    rawChainOfThought: "not requested or retained",
    suiteRunId: suite.suiteRunId,
    report: path.basename(jsonPath),
    html: path.basename(htmlPath),
    descriptorBundle: "descriptor-bundle.json",
    codexSubagentPrompt: "codex-subagent-prompt.md",
    reportSha256: sha256(await readFile(jsonPath, "utf8")),
  }, null, 2));
  console.log(JSON.stringify({ outputDir, report: jsonPath, html: htmlPath, descriptorBundle: path.join(outputDir, "descriptor-bundle.json") }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
