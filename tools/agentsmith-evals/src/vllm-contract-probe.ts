import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSmithConfigFromPolicy } from "../../../src/core/resolved-policy.js";
import { VllmProvider, type ProviderResponse } from "../../../src/agentsmith/provider.js";
import { resolveVllmEvalTreatment } from "./vllm-treatment.js";

type Probe = { id: string; thinking: boolean; schema: boolean };
type Row = {
  probe: string;
  path: "direct" | "adapter";
  serverFlags: string;
  thinking: boolean;
  schema: boolean;
  requestedReasoningBudget: number | null;
  forcedReasoningEndTokens: number | null;
  requestedOutputBudget: number;
  promptTokens: number | null;
  reasoningTokens: number | null;
  finalContentTokens: number | null;
  contentPresent: boolean;
  schemaValid: boolean | null;
  finishReason: string | null;
  separated: boolean;
  latencyMs: number | null;
  error: string | null;
  classification: string;
  explanation: string;
  reasoningChars?: number;
  contentChars?: number;
  tracePath?: string;
};

const probes: Probe[] = [
  { id: "A", thinking: false, schema: false },
  { id: "B", thinking: true, schema: false },
  { id: "C", thinking: false, schema: true },
  { id: "D", thinking: true, schema: true },
];

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

function args() {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index++) {
    const value = process.argv[index];
    if (!value.startsWith("--")) continue;
    values.set(value, process.argv[index + 1] ?? "");
    index++;
  }
  return {
    url: values.get("--url") ?? process.env.MATRIXCORE_VLLM_URL ?? "http://127.0.0.1:8001/v1",
    model: values.get("--model") ?? "mlx-community/Qwen3.5-4B-MLX-4bit",
    context: Number(values.get("--context") ?? 4096),
    output: Number(values.get("--output-tokens") ?? 300),
    reasoning: Number(values.get("--reasoning-tokens") ?? 64),
    treatment: values.get("--treatment"),
    forcedReasoningEnd: values.get("--forced-reasoning-end") ?? "I have to give the solution based on the reasoning directly now.</think>",
    serverFlags: values.get("--server-flags") ?? "enable_in_reasoning=false",
    outputPath: values.get("--output") ?? ".quality/evals/vllm-contract-probe.json",
    path: values.get("--path") ?? "direct",
    stream: values.get("--stream") !== "false",
    traceDir: values.get("--trace-dir") ?? ".quality/evals/vllm-contract-traces",
  };
}

async function tokenizeText(config: ReturnType<typeof args>, text: string): Promise<number> {
  const response = await fetch(tokenizeUrl(config.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, prompt: text, add_special_tokens: false }),
  });
  if (!response.ok) throw new Error(`vLLM forced-end tokenization HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body: any = await response.json();
  const count = Number(body.count ?? body.token_ids?.length ?? body.tokens?.length);
  if (!Number.isInteger(count) || count < 1) throw new Error("vLLM returned no forced reasoning-end tokens");
  return count;
}

function tokenizeUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return base.endsWith("/v1") ? `${base.slice(0, -3)}/tokenize` : `${base}/tokenize`;
}

function modelsUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

async function verifyLoadedModel(config: ReturnType<typeof args>) {
  const response = await fetch(modelsUrl(config.url));
  if (!response.ok) throw new Error(`vLLM model discovery HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body: any = await response.json();
  const models = (body.data ?? [])
    .map((entry: any) => entry?.id)
    .filter((value: unknown): value is string => typeof value === "string");
  if (!models.includes(config.model))
    throw new Error(`vLLM loaded model mismatch: requested=${config.model}, available=${models.join(",") || "none"}`);
  return models;
}

function contentIsValid(content: string, expectedSchema: boolean) {
  if (!expectedSchema) return null;
  try {
    const value = JSON.parse(content);
    return typeof value?.ok === "boolean" && Object.keys(value).length === 1;
  } catch {
    return false;
  }
}

function adapterContentIsValid(content: string, expectedSchema: boolean) {
  if (!expectedSchema) return null;
  try {
    const value = JSON.parse(content);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function classify(row: Pick<Row, "error" | "finishReason" | "contentPresent" | "schemaValid" | "thinking" | "schema" | "reasoningTokens" | "requestedReasoningBudget" | "forcedReasoningEndTokens">) {
  if (row.error) return ["provider-error", row.error];
  if (row.finishReason === "length" && !row.contentPresent) return ["total-output-exhaustion", "generation ended before final content"]; 
  if (row.thinking && row.schema && !row.contentPresent) return ["thinking-schema-failure", "reasoning was returned without final structured content"];
  if (row.schema && row.schemaValid === false) return ["schema-failure", "final content was not valid for the requested schema"];
  if (row.thinking && row.requestedReasoningBudget !== null && row.reasoningTokens !== null && row.forcedReasoningEndTokens !== null && row.reasoningTokens > row.requestedReasoningBudget + row.forcedReasoningEndTokens)
    return ["reasoning-budget-failure", "reported reasoning tokens exceeded the requested budget"];
  return ["working", "requested response channels completed"]; 
}

async function directProbe(config: ReturnType<typeof args>, probe: Probe, forcedReasoningEndTokens: number): Promise<Row> {
  const started = Date.now();
  let promptTokens: number | null = null;
  let body: any;
  try {
    const messages = [{ role: "user", content: "Analyze briefly whether a member session can delete a user when the guard only rejects missing sessions." }];
    const tokenResponse = await fetch(tokenizeUrl(config.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: probe.thinking } }),
    });
    const tokenBody: any = await tokenResponse.json();
    promptTokens = Number(tokenBody.count ?? tokenBody.token_ids?.length ?? tokenBody.tokens?.length);
    const request: any = {
      model: config.model,
      messages,
      max_tokens: config.output,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      stream: config.stream,
      ...(config.stream ? { stream_options: { include_usage: true } } : {}),
      chat_template_kwargs: { enable_thinking: probe.thinking },
      ...(probe.thinking ? { thinking_token_budget: config.reasoning } : {}),
      ...(probe.schema ? { response_format: { type: "json_schema", json_schema: { name: `probe_${probe.id}`, strict: true, schema } } } : {}),
    };
    const response = await fetch(`${config.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (config.stream) {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("vLLM streaming response has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      let reasoningText = "";
      let contentText = "";
      let finalChunk: any = {};
      let finishReason: string | null = null;
      let usage: any = {};
      let sequence = 0;
      const tracePath = path.join(config.traceDir, `${probe.id}.ndjson`);
      await mkdir(path.dirname(tracePath), { recursive: true });
      await writeFile(tracePath, `${JSON.stringify({ type: "request", at: new Date().toISOString(), request })}\n`);
      const consume = async (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") return;
        const chunk = JSON.parse(payload) as any;
        finalChunk = { ...finalChunk, ...chunk };
        const delta = chunk.choices?.[0]?.delta ?? {};
        const reasoningDelta = String(delta.reasoning ?? delta.reasoning_content ?? "");
        const contentDelta = String(delta.content ?? "");
        reasoningText += reasoningDelta;
        contentText += contentDelta;
        await appendFile(tracePath, `${JSON.stringify({ type: "chunk", sequence: sequence++, at: new Date().toISOString(), chunk, reasoningDelta, contentDelta })}\n`);
        if (chunk.usage) usage = chunk.usage;
        if (chunk.choices?.[0]?.finish_reason) finishReason = String(chunk.choices[0].finish_reason);
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
        choices: [{ finish_reason: finishReason, message: { reasoning: reasoningText, content: contentText } }],
        usage,
      };
      await appendFile(tracePath, `${JSON.stringify({ type: "complete", at: new Date().toISOString(), reasoningChars: reasoningText.length, contentChars: contentText.length })}\n`);
      body.__tracePath = tracePath;
    } else {
      body = await response.json();
    }
    const message = body.choices?.[0]?.message ?? {};
    const content = String(message.content ?? "");
    const reasoning = String(message.reasoning ?? message.reasoning_content ?? "");
    const usage = body.usage ?? {};
    const reasoningTokens = Number.isFinite(usage.completion_tokens_details?.reasoning_tokens) ? Number(usage.completion_tokens_details.reasoning_tokens) : null;
    const [classification, explanation] = classify({
      error: null,
      finishReason: body.choices?.[0]?.finish_reason ?? null,
      contentPresent: content.length > 0,
      schemaValid: contentIsValid(content, probe.schema),
      thinking: probe.thinking,
      schema: probe.schema,
      reasoningTokens,
      requestedReasoningBudget: probe.thinking ? config.reasoning : null,
      forcedReasoningEndTokens: probe.thinking ? forcedReasoningEndTokens : null,
    });
    return {
      probe: probe.id, path: "direct", serverFlags: config.serverFlags, thinking: probe.thinking, schema: probe.schema,
      requestedReasoningBudget: probe.thinking ? config.reasoning : null, requestedOutputBudget: config.output, promptTokens,
      forcedReasoningEndTokens: probe.thinking ? forcedReasoningEndTokens : null,
      reasoningTokens, finalContentTokens: reasoningTokens === null ? null : Math.max(0, Number(usage.completion_tokens ?? 0) - reasoningTokens),
      contentPresent: content.length > 0, schemaValid: contentIsValid(content, probe.schema), finishReason: body.choices?.[0]?.finish_reason ?? null,
      separated: !probe.thinking || (reasoning.length > 0 && content.length > 0), latencyMs: Date.now() - started, error: null,
      classification, explanation, reasoningChars: reasoning.length, contentChars: content.length, tracePath: body.__tracePath,
    };
  } catch (error) {
    return {
      probe: probe.id, path: "direct", serverFlags: config.serverFlags, thinking: probe.thinking, schema: probe.schema,
      requestedReasoningBudget: probe.thinking ? config.reasoning : null, requestedOutputBudget: config.output, promptTokens,
      forcedReasoningEndTokens: probe.thinking ? forcedReasoningEndTokens : null,
      reasoningTokens: null, finalContentTokens: null, contentPresent: false, schemaValid: probe.schema ? false : null, finishReason: null,
      separated: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error),
      classification: "provider-error", explanation: "request failed before a valid response was returned",
    };
  }
}

function print(rows: Row[]) {
  const columns = ["probe", "path", "thinking", "schema", "promptTokens", "reasoningTokens", "reasoningChars", "contentChars", "contentPresent", "schemaValid", "finishReason", "classification"] as const;
  console.table(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))));
}

async function main() {
  const parsed = args();
  const treatment = resolveVllmEvalTreatment(parsed.treatment);
  const config = treatment
    ? { ...parsed, model: treatment.candidateModel, context: treatment.candidateContextTokens, output: treatment.candidateOutputTokens, reasoning: treatment.candidateThinkingTokens }
    : parsed;
  if (!["direct", "adapter"].includes(config.path)) throw new Error("--path must be direct or adapter");
  const serverModels = await verifyLoadedModel(config);
  const forcedReasoningEndTokens = await tokenizeText(config, config.forcedReasoningEnd);
  const rows: Row[] = [];
  for (const probe of probes) {
    if (config.path === "direct") rows.push(await directProbe(config, probe, forcedReasoningEndTokens));
    else {
      const base = agentSmithConfigFromPolicy(true);
      const profile = base.model_profiles.find((item) => item.id === base.models.candidate) ?? base.model_profiles[0];
      const provider = new VllmProvider({ ...base, provider: "vllm", base_url: config.url, model_profiles: base.model_profiles.map((item) => item.id === profile.id ? { ...item, provider: "vllm", model: config.model, contextTokens: config.context, requestedOutputTokens: config.output } : item) });
      const started = Date.now();
      let response: ProviderResponse | undefined;
      let error: string | null = null;
      try { response = await provider.invoke({ profile: { ...profile, provider: "vllm", model: config.model, contextTokens: config.context, requestedOutputTokens: config.output }, prompt: "Analyze briefly whether a member session can delete a user when the guard only rejects missing sessions.", outputKind: "candidates", inferenceMode: probe.thinking ? (probe.schema ? "thinking-structured" : "thinking-no-format") : "structured", inferenceOverrides: { thinkingTokens: probe.thinking ? config.reasoning : undefined }, stream: config.stream, streamTracePath: path.join(config.traceDir, `${probe.id}-adapter.ndjson`), }); }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      const content = response?.raw ?? "";
      const [classification, explanation] = classify({ error, finishReason: response?.completion?.doneReason ?? null, contentPresent: content.length > 0, schemaValid: probe.schema ? content.length > 0 : null, thinking: probe.thinking, schema: probe.schema, reasoningTokens: response?.usage.reasoningTokens ?? null, requestedReasoningBudget: probe.thinking ? config.reasoning : null, forcedReasoningEndTokens: probe.thinking ? forcedReasoningEndTokens : null });
      rows.push({ probe: probe.id, path: "adapter", serverFlags: config.serverFlags, thinking: probe.thinking, schema: probe.schema, requestedReasoningBudget: probe.thinking ? config.reasoning : null, forcedReasoningEndTokens: probe.thinking ? forcedReasoningEndTokens : null, requestedOutputBudget: config.output, promptTokens: response?.usage.inputTokens ?? null, reasoningTokens: response?.usage.reasoningTokens ?? null, finalContentTokens: response?.usage.finalContentTokens ?? null, contentPresent: content.length > 0, schemaValid: adapterContentIsValid(content, probe.schema), finishReason: response?.completion?.doneReason ?? null, separated: Boolean(!probe.thinking || (response?.thinking && content)), latencyMs: Date.now() - started, error, classification, explanation, reasoningChars: response?.thinking?.length ?? 0, contentChars: content.length, tracePath: config.stream ? path.join(config.traceDir, `${probe.id}-adapter.ndjson`) : undefined });
    }
  }
  print(rows);
  await mkdir(path.dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify({ configuration: { ...config, treatment: treatment?.id ?? null, serverModels, forcedReasoningEndTokens }, rows }, null, 2)}\n`);
}

await main();
