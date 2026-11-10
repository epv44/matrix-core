import { mkdir, readFile, writeFile } from "node:fs/promises";
import { candidateSystemPrompt } from "../../../src/agentsmith/candidate-generation.js";
import {
  answerFromGuidedContinuation,
  parseCommitAllowList,
  scoreCommitAnswer,
  type CommitScoreResult,
} from "../../../src/agentsmith/commit-score.js";
import { sha256 } from "../../../src/core/hash.js";

const ARTIFACT = ".quality/evals/hillclimb/auth-witness-dispatch-live.json";
const REPORT = ".quality/evals/hillclimb/commit-handoff-probes.json";
const SOURCE_ID = "interaction:2f4741117f31012cc3be";
const MODEL = "qwen3.5:9b-q4_K_M";
const BASE_URL = process.env.OLLAMA_HOST?.startsWith("http")
  ? process.env.OLLAMA_HOST
  : `http://${process.env.OLLAMA_HOST ?? "127.0.0.1:11434"}`;
const TRIALS = 3;
const COMMIT_PREAMBLE = `End the answer with exactly one line of this form:
DECISION: finding|no_finding|insufficient_context WITNESS: <key|none> RULE: <id|none>
Use a supplied witness key and rule id only when DECISION is finding. Otherwise use none for both.`;

interface FrozenCall {
  prompt: string;
  raw: string;
  thinking: string;
  systemPromptSha256: string;
}

interface GenerateResult {
  response: string;
  thinking: string;
  doneReason: string | null;
  thinkBudget: number | string | null;
  thinkBudgetTokens: number | null;
  evalCount: number | null;
  totalDurationMs: number | null;
}

async function main() {
  const frozen = await loadFrozenCall();
  const marker = "\nWork item:";
  const splitAt = frozen.prompt.indexOf(marker);
  if (splitAt < 0) throw new Error("frozen interaction prompt has no work item body");
  const workItemBody = frozen.prompt.slice(splitAt + 1);
  const allow = parseCommitAllowList(workItemBody);
  if (allow.witnessKeys.length === 0 || allow.ruleIds.length === 0)
    throw new Error("frozen work item did not yield witness keys and rule ids");
  const systemPrompt = candidateSystemPrompt(
    "branch-analysis-delta-first-v3",
    "host-referenced-witness",
    "ollama",
    "thinking-structured",
  );
  if (!systemPrompt) throw new Error("delta-first witness system prompt is missing");
  if (sha256(systemPrompt) !== frozen.systemPromptSha256)
    throw new Error("reconstructed system prompt does not match the frozen control");
  const experimentPrompt = `${COMMIT_PREAMBLE}\n\n${workItemBody}`;
  const control = scoreCommitAnswer({
    answer: frozen.raw,
    thinking: frozen.thinking,
    allowedWitnessKeys: allow.witnessKeys,
    allowedRuleIds: allow.ruleIds,
  });
  await mkdir(".quality/evals/hillclimb", { recursive: true });
  const report: Record<string, unknown> = {
    model: MODEL,
    baseUrl: BASE_URL,
    sourceId: SOURCE_ID,
    allowed: allow,
    control: {
      source: ARTIFACT,
      replayed: false,
      raw: frozen.raw,
      thinkingSha256: sha256(frozen.thinking),
      ...control,
    },
    trials: [] as unknown[],
  };
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `control ${JSON.stringify(control.score)} thinkingMentionsWitness=${control.thinkingMentionsAllowedWitness}`,
  );
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    console.log(`trial ${trial} unguided`);
    const unguided = await generate({
      model: MODEL,
      system: systemPrompt,
      prompt: experimentPrompt,
      stream: false,
      think: true,
      options: sampling(3072, 2048),
    });
    const unguidedScore = scoreCommitAnswer({
      answer: unguided.response,
      thinking: unguided.thinking,
      allowedWitnessKeys: allow.witnessKeys,
      allowedRuleIds: allow.ruleIds,
    });
    console.log(`trial ${trial} guided`);
    const guidedPrompt = renderGuided(systemPrompt, experimentPrompt, unguided.thinking);
    const guided = await generate({
      model: MODEL,
      prompt: guidedPrompt,
      raw: true,
      stream: false,
      think: false,
      options: sampling(128),
    });
    const guidedAnswer = answerFromGuidedContinuation(guided.response);
    const guidedScore = scoreCommitAnswer({
      answer: guidedAnswer,
      thinking: unguided.thinking,
      allowedWitnessKeys: allow.witnessKeys,
      allowedRuleIds: allow.ruleIds,
    });
    (report.trials as unknown[]).push({
      trial,
      unguided: trialRecord(unguided, unguidedScore, unguided.response),
      guided: trialRecord(guided, guidedScore, guidedAnswer),
    });
    await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `trial ${trial} unguided=${JSON.stringify(unguidedScore.score)} guided=${JSON.stringify(guidedScore.score)}`,
    );
  }
}

function trialRecord(result: GenerateResult, scored: CommitScoreResult, answer: string) {
  return {
    answer,
    thinkingSha256: sha256(result.thinking),
    doneReason: result.doneReason,
    thinkBudget: result.thinkBudget,
    thinkBudgetTokens: result.thinkBudgetTokens,
    evalCount: result.evalCount,
    totalDurationMs: result.totalDurationMs,
    ...scored,
  };
}

function sampling(numPredict: number, thinkBudget?: number) {
  return {
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    num_ctx: 6144,
    num_predict: numPredict,
    ...(thinkBudget !== undefined ? { think_budget: thinkBudget } : {}),
  };
}

function renderGuided(system: string, user: string, thinking: string): string {
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n${thinking}\n</think>\nDECISION:`;
}

async function generate(body: Record<string, unknown>): Promise<GenerateResult> {
  const response = await fetch(`${BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ollama streaming response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let responseText = "";
  let thinkingText = "";
  let finalChunk: Record<string, unknown> = {};
  const consume = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as Record<string, unknown>;
    finalChunk = chunk;
    responseText += String(chunk.response ?? "");
    thinkingText += String(chunk.thinking ?? "");
  };
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (next.done) break;
  }
  consume(buffer);
  const total = Number(finalChunk.total_duration);
  return {
    response: responseText,
    thinking: thinkingText,
    doneReason: typeof finalChunk.done_reason === "string" ? finalChunk.done_reason : null,
    thinkBudget: (finalChunk.think_budget as number | string | undefined) ?? null,
    thinkBudgetTokens: Number.isFinite(finalChunk.think_budget_tokens) ? Number(finalChunk.think_budget_tokens) : null,
    evalCount: Number.isFinite(finalChunk.eval_count) ? Number(finalChunk.eval_count) : null,
    totalDurationMs: Number.isFinite(total) ? total / 1_000_000 : null,
  };
}

async function loadFrozenCall(): Promise<FrozenCall> {
  const doc = JSON.parse(await readFile(ARTIFACT, "utf8")) as unknown;
  const found = findCall(doc);
  if (!found) throw new Error(`frozen artifact is missing ${SOURCE_ID}`);
  return found;
}

function findCall(value: unknown): FrozenCall | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCall(entry);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.sourceId === SOURCE_ID && typeof record.prompt === "string" && typeof record.raw === "string") {
    const contract = record.contract as Record<string, unknown> | undefined;
    return {
      prompt: record.prompt,
      raw: record.raw,
      thinking: typeof record.thinking === "string" ? record.thinking : "",
      systemPromptSha256: String(contract?.systemPromptSha256 ?? ""),
    };
  }
  for (const entry of Object.values(record)) {
    const found = findCall(entry);
    if (found) return found;
  }
  return undefined;
}

await main();
