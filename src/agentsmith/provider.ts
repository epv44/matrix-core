import type { AgentSmithConfig, ModelProfile } from "../core/types.js";
import type { CandidateGenerationArm, CandidateInferenceMode } from "./engine-types.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type ReviewOutputKind = "candidates" | "specialist" | "scout" | "verification" | "citation-selection";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  finalContentTokens?: number | null;
}

export interface ProviderCompletionMetadata {
  model: string;
  done: boolean | null;
  doneReason: string | null;
  thinkBudget?: number | string | null;
  thinkBudgetTokens?: number | null;
  totalDurationNs: number | null;
  loadDurationNs: number | null;
  promptEvalDurationNs: number | null;
  evalDurationNs: number | null;
}

export interface ProviderResponse {
  raw: string;
  usage: ProviderUsage;
  thinking?: string;
  /** A provider-produced diagnostic summary, never raw reasoning tokens. */
  reasoningSummary?: string;
  completion?: ProviderCompletionMetadata;
}

export interface ReviewProviderInput {
  profile: ModelProfile;
  prompt: string;
  outputKind: ReviewOutputKind;
  allowedFiles?: string[];
  maxCandidates?: number;
  evidenceSelectorKeys?: string[];
  allowedRuleIds?: string[];
  allowedWitnessKeys?: string[];
  candidateArm?: CandidateGenerationArm;
  inferenceMode?: CandidateInferenceMode;
  systemPrompt?: string;
  inferenceOverrides?: { contextTokens?: number; outputTokens?: number; thinkingTokens?: number };
  stream?: boolean;
  streamTracePath?: string;
  signal?: AbortSignal;
}

export interface ReviewProvider {
  health(signal?: AbortSignal): Promise<{ ok: boolean; models: string[]; error?: string }>;
  invoke(input: ReviewProviderInput): Promise<ProviderResponse>;
}

function compactCandidateProperties(
  allowedFiles?: string[],
  evidenceSelectorKeys?: string[],
) {
  // Ollama rejects JSON Schema enum values when the array is empty. A task
  // with no bounded selectors still uses the bounded request shape, but no
  // selector can resolve; candidate-generation will drop any such request.
  // Keep the schema valid so the model can return e: [] and continue review.
  const selector = evidenceSelectorKeys?.length
    ? { type: "string", enum: [...new Set(evidenceSelectorKeys)] }
    : { type: "string", minLength: 1 };
  return {
    f: allowedFiles?.length ? { type: "string", enum: [...new Set(allowedFiles)] } : { type: "string", minLength: 1 },
    l: { type: "integer", minimum: 1 },
    x: { type: "integer", minimum: 1 },
    s: { type: "string", enum: ["critical", "high", "medium", "low"] },
    k: { type: "string", enum: ["correctness", "security", "performance", "contract"] },
    t: { type: "string", minLength: 1, maxLength: 80 },
    d: { type: "string", minLength: 1, maxLength: 280 },
    g: { type: "string", maxLength: 160 },
    p: { type: "string", maxLength: 160 },
    r: { type: "string", maxLength: 120 },
    q: { type: "number", minimum: 0, maximum: 1, description: "Candidate confidence as a decimal from 0 through 1." },
    e: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: evidenceSelectorKeys !== undefined ? ["selector", "r"] : ["k", "v", "r"],
        properties: {
          ...(evidenceSelectorKeys !== undefined ? { selector } : {}),
          ...(evidenceSelectorKeys === undefined
            ? {
                k: {
                  type: "string",
                  description: "Evidence relationship or lookup kind.",
                  enum: [
                    "definition",
                    "callers",
                    "callees",
                    "type",
                    "implementation",
                    "usage",
                    "config",
                    "test",
                    "schema",
                    "search",
                  ],
                },
              }
            : {}),
          ...(evidenceSelectorKeys === undefined
            ? {
                v: {
                  type: "string",
                  minLength: 1,
                  maxLength: 240,
                  description: "Required symbol for semantic lookups or literal value for search/config/test/schema lookups.",
                },
                m: { type: "string", enum: ["symbol", "literal"] },
                p: { type: "string", maxLength: 240, description: "Optional repository-relative path hint." },
              }
            : {}),
          r: { type: "string", minLength: 1, maxLength: 120, description: "Why this evidence is needed." },
        },
      },
    },
  };
}

export function reviewOutputSchema(
  kind: ReviewOutputKind,
  allowedFiles?: string[],
  maxCandidates = 2,
  evidenceSelectorKeys?: string[],
  candidateArm: CandidateGenerationArm = "simplified-contract",
  allowedRuleIds?: string[],
  allowedWitnessKeys?: string[],
) {
  if (kind === "citation-selection")
    return {
      type: "object",
      additionalProperties: false,
      required: ["citations"],
      properties: {
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["requestId", "evidenceId"],
            properties: {
              requestId: { type: "string" },
              evidenceId: { type: "string" },
            },
          },
        },
      },
    };
  if (kind === "verification")
    return {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "confidence", "supportingEvidenceIds"],
      properties: {
        verdict: { type: "string", enum: ["verified", "likely", "rejected", "insufficient_evidence"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reasoningSummary: { type: "string" },
        supportingEvidenceIds: { type: "array", items: { type: "string" } },
      },
    };
  if (kind === "scout")
    return {
      type: "object",
      additionalProperties: false,
      required: ["hotspots"],
      properties: {
        hotspots: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["hotspotId", "risk", "category", "symbols", "edges", "rationale", "requestedInspection"],
            properties: {
              hotspotId: { type: "string" },
              risk: { type: "string", enum: ["critical", "high", "medium", "low"] },
              category: { type: "string", enum: ["correctness", "security", "performance", "contract"] },
              symbols: { type: "array", items: { type: "string" } },
              edges: { type: "array", items: { type: "string" } },
              rationale: { type: "string" },
              requestedInspection: {
                type: "object",
                required: ["symbols"],
                properties: {
                  symbols: { type: "array", items: { type: "string" } },
                  edgeKinds: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
  const ruleBound = candidateArm === "rule-bound-classification";
  const witnessBound = candidateArm === "host-referenced-witness";
  const candidateOutput = {
    type: "object",
    additionalProperties: false,
    required: kind === "specialist" || (candidateArm !== "simplified-contract" && !ruleBound && !witnessBound) ? [kind === "specialist" ? "summary" : "c"] : ["state", "candidates"],
    properties: {
      ...(kind === "specialist" || (candidateArm !== "simplified-contract" && !ruleBound && !witnessBound)
        ? {
            ...(kind === "specialist" ? { summary: { type: "string", minLength: 1, maxLength: 1200 } } : {}),
            c: {
              type: "array",
              maxItems: maxCandidates,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["f", "l", "s", "k", "t", "d", "q", "e"],
                properties: compactCandidateProperties(allowedFiles, candidateArm === "host-defaults" ? evidenceSelectorKeys : undefined),
              },
            },
          }
        : {
            state: { type: "string", enum: ["finding", "no_finding", "insufficient_context"] },
            candidates: {
              type: "array",
              maxItems: maxCandidates,
              items: {
                type: "object",
                additionalProperties: false,
                required: witnessBound
                  ? ["file", "line", "witnessKey", "basisRuleId", "impact", "confidence"]
                  : ["file", "line", "severity", "category", "trigger", "invariant", "impact", "confidence", ...(ruleBound ? ["basisRuleId"] : [])],
                properties: {
                  file: allowedFiles?.length ? { type: "string", enum: [...new Set(allowedFiles)] } : { type: "string", minLength: 1 },
                  line: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  ...(witnessBound
                    ? {
                        witnessKey: allowedWitnessKeys?.length
                          ? { type: "string", enum: [...new Set(allowedWitnessKeys)] }
                          : { type: "string", minLength: 1 },
                      }
                    : {
                        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                        category: { type: "string", enum: ["correctness", "security", "performance", "contract"] },
                        trigger: { type: "string", minLength: 1, maxLength: 160 },
                        invariant: { type: "string", minLength: 1, maxLength: 240 },
                      }),
                  impact: { type: "string", minLength: 1, maxLength: 240 },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  ...(ruleBound || witnessBound
                    ? {
                        basisRuleId: allowedRuleIds?.length
                          ? { type: "string", enum: [...new Set(allowedRuleIds)] }
                          : { type: "string", minLength: 1 },
                      }
                    : {}),
                },
              },
            },
          }),
    },
  };
  return candidateOutput;
}

/**
 * OpenAI's strict Structured Outputs dialect requires every declared object
 * property to be present in `required`. Internal AgentSmith schemas use normal
 * JSON Schema optional fields, so adapt only the wire schema for this provider:
 * omitted internal fields become explicitly nullable required fields.
 */
export function openAiStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const source = schema as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) continue;
    if (key === "required") continue;
    if (key === "items") {
      normalized.items = openAiStrictSchema(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      normalized[key] = value.map(openAiStrictSchema);
      continue;
    }
    normalized[key] = value;
  }
  if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) return normalized;
  const properties = source.properties as Record<string, unknown>;
  const originallyRequired = new Set(Array.isArray(source.required) ? source.required.filter((key): key is string => typeof key === "string") : []);
  normalized.properties = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const property = openAiStrictSchema(value);
      return [key, originallyRequired.has(key) ? property : { anyOf: [property, { type: "null" }] }];
    }),
  );
  normalized.required = Object.keys(properties);
  return normalized;
}

async function writeStreamTrace(tracePath: string, value: unknown) {
  await mkdir(path.dirname(tracePath), { recursive: true });
  await appendFile(tracePath, `${JSON.stringify(value)}\n`, "utf8");
}

export class OllamaProvider implements ReviewProvider {
  constructor(private config: AgentSmithConfig) {}

  async health(signal?: AbortSignal) {
    try {
      const response = await fetch(`${this.config.base_url}/api/tags`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: any = await response.json();
      return { ok: true, models: (body.models ?? []).map((model: any) => model.name) };
    } catch (error: any) {
      return { ok: false, models: [], error: error.message };
    }
  }

  async invoke(input: ReviewProviderInput): Promise<ProviderResponse> {
    const thinkingStructured = input.inferenceMode === "thinking-structured";
    const boundedThinking = thinkingStructured && input.inferenceOverrides?.thinkingTokens !== undefined;
    // Ollama's bounded-reasoning branch currently wires explicit parser
    // delimiters through /api/generate. Keep the established chat path for
    // unbounded thinking diagnostics, but use generate when a hard reasoning
    // budget is part of the request contract.
    const useChat = thinkingStructured && !boundedThinking;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Ollama request timed out")),
      input.profile.inference.timeoutMs,
    );
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const streaming = input.stream === true;
      if (streaming && input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, { type: "request", at: new Date().toISOString(), model: input.profile.model });
      const response = await fetch(`${this.config.base_url}${useChat ? "/api/chat" : "/api/generate"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.profile.model,
          ...(useChat
            ? {
                messages: [
                  ...(input.systemPrompt !== undefined ? [{ role: "system", content: input.systemPrompt }] : []),
                  { role: "user", content: input.prompt },
                ],
              }
            : { prompt: input.prompt }),
          stream: streaming,
          ...(!useChat && input.systemPrompt !== undefined ? { system: input.systemPrompt } : {}),
          think: thinkingStructured || input.inferenceMode === "thinking-no-format" ? true : input.profile.inference.thinking,
          ...(input.inferenceMode === "thinking-no-format"
            ? {}
            : {
                format: reviewOutputSchema(
                  input.outputKind,
                  input.allowedFiles,
                  input.maxCandidates,
                  input.evidenceSelectorKeys,
                  input.candidateArm,
                  input.allowedRuleIds,
                  input.allowedWitnessKeys,
                ),
              }),
          keep_alive: `${Math.ceil(this.config.maxDurationMs / 60_000) + 5}m`,
          options: {
            temperature: input.profile.inference.temperature,
            ...(input.profile.inference.topP !== undefined ? { top_p: input.profile.inference.topP } : {}),
            ...(input.profile.inference.topK !== undefined ? { top_k: input.profile.inference.topK } : {}),
            num_ctx: input.inferenceOverrides?.contextTokens ?? input.profile.contextTokens,
            num_predict: input.inferenceOverrides?.outputTokens ?? input.profile.requestedOutputTokens,
            ...(boundedThinking ? { think_budget: input.inferenceOverrides!.thinkingTokens } : {}),
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      let body: any;
      if (!streaming) {
        body = await response.json();
      } else {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Ollama streaming response has no body");
        const decoder = new TextDecoder();
        let buffer = "";
        let responseText = "";
        let thinkingText = "";
        let finalChunk: any = {};
        let sequence = 0;
        const consume = async (line: string) => {
          if (!line.trim()) return;
          const chunk = JSON.parse(line) as any;
          finalChunk = chunk;
          const message = chunk.message && typeof chunk.message === "object" ? chunk.message : undefined;
          const contentDelta = String(message?.content ?? chunk.response ?? "");
          const thinkingDelta = String(message?.thinking ?? chunk.thinking ?? "");
          responseText += contentDelta;
          thinkingText += thinkingDelta;
          if (input.streamTracePath)
            await writeStreamTrace(input.streamTracePath, {
              type: "chunk",
              sequence: sequence++,
              at: new Date().toISOString(),
              chunk,
              contentDelta,
              thinkingDelta,
            });
        };
        while (true) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) await consume(line);
          if (next.done) break;
        }
        await consume(buffer);
        body = {
          ...finalChunk,
          response: responseText,
          thinking: thinkingText,
          message: { ...(finalChunk.message ?? {}), content: responseText, thinking: thinkingText },
        };
      }
      const message = useChat && body.message && typeof body.message === "object" ? body.message : undefined;
      return {
        raw: String(message?.content ?? body.response ?? ""),
        ...(typeof (message?.thinking ?? body.thinking) === "string" ? { thinking: message?.thinking ?? body.thinking } : {}),
        usage: {
          inputTokens: Number(body.prompt_eval_count ?? 0),
          outputTokens: Number(body.eval_count ?? 0),
        },
        completion: {
          model: String(body.model ?? input.profile.model),
          done: typeof body.done === "boolean" ? body.done : null,
          doneReason: typeof body.done_reason === "string" ? body.done_reason : null,
          ...(body.think_budget !== undefined ? { thinkBudget: body.think_budget as number | string } : {}),
          ...(Number.isFinite(body.think_budget_tokens) ? { thinkBudgetTokens: Number(body.think_budget_tokens) } : {}),
          totalDurationNs: Number.isFinite(body.total_duration) ? Number(body.total_duration) : null,
          loadDurationNs: Number.isFinite(body.load_duration) ? Number(body.load_duration) : null,
          promptEvalDurationNs: Number.isFinite(body.prompt_eval_duration) ? Number(body.prompt_eval_duration) : null,
          evalDurationNs: Number.isFinite(body.eval_duration) ? Number(body.eval_duration) : null,
        },
      };
    } catch (error) {
      if (input.stream && input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, {
          type: "error",
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

function vllmBaseUrl(config: AgentSmithConfig): string {
  return config.base_url.replace(/\/$/, "");
}

function vllmTokenizeUrl(config: AgentSmithConfig): string {
  const base = vllmBaseUrl(config);
  return base.endsWith("/v1") ? `${base.slice(0, -3)}/tokenize` : `${base}/tokenize`;
}

async function vllmPromptTokens(
  config: AgentSmithConfig,
  input: ReviewProviderInput,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
): Promise<number> {
  const response = await fetch(vllmTokenizeUrl(config), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.profile.model,
      messages,
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: input.inferenceMode?.startsWith("thinking-") === true },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`vLLM tokenize HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body: any = await response.json();
  const count = Number(body.count ?? body.token_ids?.length ?? body.tokens?.length);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("vLLM tokenize response omitted a valid token count");
  return count;
}

function vllmOutputTokenBudget(input: ReviewProviderInput, promptTokens: number): number {
  const requested = input.inferenceOverrides?.outputTokens ?? input.profile.requestedOutputTokens;
  const context = input.inferenceOverrides?.contextTokens ?? input.profile.contextTokens;
  const available = context - promptTokens - input.profile.safetyReserveTokens;
  if (available < 1)
    throw new Error(`vLLM prompt exceeds context budget: prompt=${promptTokens}, context=${context}, safetyReserve=${input.profile.safetyReserveTokens}`);
  if (requested > available)
    throw new Error(`vLLM output budget exceeds context: requested=${requested}, available=${available}, prompt=${promptTokens}, context=${context}, safetyReserve=${input.profile.safetyReserveTokens}`);
  return requested;
}

function vllmResponseFormat(input: ReviewProviderInput) {
  if (input.inferenceMode === "thinking-no-format") return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: `agentsmith_${input.outputKind.replace(/[^A-Za-z0-9_]/g, "_")}`,
      strict: true,
      schema: reviewOutputSchema(input.outputKind, input.allowedFiles, input.maxCandidates, input.evidenceSelectorKeys, input.candidateArm, input.allowedRuleIds, input.allowedWitnessKeys),
    },
  };
}

function vllmCompletion(body: any, input: ReviewProviderInput, reasoning: string, content: string): ProviderResponse {
  const choice = body.choices?.[0];
  const message = choice?.message ?? {};
  const rawContent = content || String(message.content ?? "");
  const rawReasoning = reasoning || String(message.reasoning ?? message.reasoning_content ?? "");
  const usage = body.usage ?? {};
  return {
    raw: rawContent,
    ...(rawReasoning ? { thinking: rawReasoning } : {}),
    usage: {
      inputTokens: Number(usage.prompt_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? 0),
      ...(Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
        ? { reasoningTokens: Number(usage.completion_tokens_details.reasoning_tokens) }
        : {}),
      ...(Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
        ? { finalContentTokens: Math.max(0, Number(usage.completion_tokens ?? 0) - Number(usage.completion_tokens_details.reasoning_tokens)) }
        : {}),
    },
    completion: {
      model: String(body.model ?? input.profile.model),
      done: true,
      doneReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      totalDurationNs: null,
      loadDurationNs: null,
      promptEvalDurationNs: null,
      evalDurationNs: null,
    },
  };
}

export class VllmProvider implements ReviewProvider {
  constructor(private config: AgentSmithConfig) {}

  async health(signal?: AbortSignal) {
    try {
      const response = await fetch(`${vllmBaseUrl(this.config)}/models`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: any = await response.json();
      return { ok: true, models: (body.data ?? []).map((model: any) => model.id).filter((value: unknown): value is string => typeof value === "string") };
    } catch (error: any) {
      return { ok: false, models: [], error: error.message };
    }
  }

  async invoke(input: ReviewProviderInput): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("vLLM request timed out")), input.profile.inference.timeoutMs);
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    const streaming = input.stream === true;
    const messages = [
      ...(input.systemPrompt !== undefined ? [{ role: "system", content: input.systemPrompt }] : []),
      { role: "user", content: input.prompt },
    ];
    try {
      const promptTokens = await vllmPromptTokens(this.config, input, messages, controller.signal);
      const body: Record<string, unknown> = {
      model: input.profile.model,
      messages,
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
      temperature: input.profile.inference.temperature,
      ...(input.profile.inference.topP !== undefined ? { top_p: input.profile.inference.topP } : {}),
      ...(input.profile.inference.topK !== undefined ? { top_k: input.profile.inference.topK } : {}),
      max_tokens: vllmOutputTokenBudget(input, promptTokens),
      ...(vllmResponseFormat(input) ? { response_format: vllmResponseFormat(input) } : {}),
      ...(input.inferenceMode?.startsWith("thinking-")
        ? {
            chat_template_kwargs: { enable_thinking: true },
            ...(input.inferenceOverrides?.thinkingTokens !== undefined
              ? { thinking_token_budget: input.inferenceOverrides.thinkingTokens }
              : {}),
          }
        : { chat_template_kwargs: { enable_thinking: false } }),
      };
      if (streaming && input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, { type: "request", at: new Date().toISOString(), model: input.profile.model, provider: "vllm", body });
      const response = await fetch(`${vllmBaseUrl(this.config)}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`vLLM HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      if (!streaming) {
        return vllmCompletion(await response.json(), input, "", "");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("vLLM streaming response has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      let reasoning = "";
      let content = "";
      let finalBody: any = {};
      let finishReason: string | null = null;
      let responseModel = input.profile.model;
      let sequence = 0;
      const consume = async (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") return;
        const chunk = JSON.parse(payload) as any;
        finalBody = { ...finalBody, ...chunk };
        if (typeof chunk.model === "string") responseModel = chunk.model;
        const delta = chunk.choices?.[0]?.delta ?? {};
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason;
        if (typeof chunkFinishReason === "string") finishReason = chunkFinishReason;
        const reasoningDelta = String(delta.reasoning ?? delta.reasoning_content ?? "");
        const contentDelta = String(delta.content ?? "");
        reasoning += reasoningDelta;
        content += contentDelta;
        if (chunk.usage) finalBody.usage = chunk.usage;
        if (input.streamTracePath)
          await writeStreamTrace(input.streamTracePath, { type: "chunk", sequence: sequence++, at: new Date().toISOString(), chunk, reasoningDelta, contentDelta });
      };
      while (true) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) await consume(line);
        if (next.done) break;
      }
      await consume(buffer);
      return vllmCompletion(
        {
          ...finalBody,
          model: responseModel,
          choices: [{ finish_reason: finishReason, message: { reasoning, content } }],
        },
        input,
        reasoning,
        content,
      );
    } catch (error) {
      if (input.stream && input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, { type: "error", at: new Date().toISOString(), provider: "vllm", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Eval-only provider for controlled Responses API diagnostics. It is deliberately
 * not selected by `createReviewProvider`, so a normal MatrixCore policy cannot
 * route production review traffic to OpenAI.
 */
export class OpenAIResponsesProvider implements ReviewProvider {
  constructor(
    private options: {
      apiKey: string;
      baseUrl?: string;
      reasoningEffort: OpenAIReasoningEffort;
    },
  ) {}

  private baseUrl() {
    return (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.apiKey}`,
    };
  }

  async health(signal?: AbortSignal) {
    try {
      const response = await fetch(`${this.baseUrl()}/models`, { headers: this.headers(), signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: any = await response.json();
      return { ok: true, models: (body.data ?? []).map((model: any) => String(model.id)).filter(Boolean) };
    } catch (error: any) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async invoke(input: ReviewProviderInput): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenAI Responses request timed out")), input.profile.inference.timeoutMs);
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    const request = {
      model: input.profile.model,
      store: false,
      ...(input.systemPrompt !== undefined ? { instructions: input.systemPrompt } : {}),
      input: input.prompt,
      max_output_tokens: input.inferenceOverrides?.outputTokens ?? input.profile.requestedOutputTokens,
      reasoning: { effort: this.options.reasoningEffort, summary: "auto" },
      text: {
        format: {
          type: "json_schema",
          name: `agentsmith_${input.outputKind.replace(/[^A-Za-z0-9_]/g, "_")}`,
          strict: true,
          schema: openAiStrictSchema(
            reviewOutputSchema(input.outputKind, input.allowedFiles, input.maxCandidates, input.evidenceSelectorKeys, input.candidateArm, input.allowedRuleIds, input.allowedWitnessKeys),
          ),
        },
      },
    };
    try {
      if (input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, { type: "request", at: new Date().toISOString(), provider: "openai-responses", body: request });
      const response = await fetch(`${this.baseUrl()}/responses`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenAI Responses HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body: any = await response.json();
      const output = Array.isArray(body.output) ? body.output : [];
      const content = output
        .filter((item: any) => item?.type === "message")
        .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
        .filter((item: any) => item?.type === "output_text")
        .map((item: any) => String(item.text ?? ""))
        .join("");
      const reasoningSummary = output
        .filter((item: any) => item?.type === "reasoning")
        .flatMap((item: any) => Array.isArray(item.summary) ? item.summary : [])
        .filter((item: any) => item?.type === "summary_text")
        .map((item: any) => String(item.text ?? ""))
        .join("\n");
      if (input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, {
          type: "response",
          at: new Date().toISOString(),
          provider: "openai-responses",
          responseId: body.id ?? null,
          model: body.model ?? input.profile.model,
          status: body.status ?? null,
          output,
          usage: body.usage ?? null,
        });
      const usage = body.usage ?? {};
      const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens);
      const outputTokens = Number(usage.output_tokens ?? 0);
      return {
        raw: content,
        ...(reasoningSummary ? { reasoningSummary } : {}),
        usage: {
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens,
          ...(Number.isFinite(reasoningTokens) ? { reasoningTokens } : {}),
          ...(Number.isFinite(reasoningTokens) ? { finalContentTokens: Math.max(0, outputTokens - reasoningTokens) } : {}),
        },
        completion: {
          model: String(body.model ?? input.profile.model),
          done: body.status === "completed",
          doneReason: body.incomplete_details?.reason ?? (typeof body.status === "string" ? body.status : null),
          totalDurationNs: null,
          loadDurationNs: null,
          promptEvalDurationNs: null,
          evalDurationNs: null,
        },
      };
    } catch (error) {
      if (input.streamTracePath)
        await writeStreamTrace(input.streamTracePath, { type: "error", at: new Date().toISOString(), provider: "openai-responses", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

export function createReviewProvider(config: AgentSmithConfig): ReviewProvider {
  if (config.provider === "vllm") return new VllmProvider(config);
  if (config.provider === "openai-responses")
    throw new Error("openai-responses is available only through the eval-only diagnostic runner");
  return new OllamaProvider(config);
}
