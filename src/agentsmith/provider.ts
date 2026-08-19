import type { AgentSmithConfig, ModelProfile } from "../core/types.js";

export type ReviewOutputKind = "candidates" | "scout" | "verification";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  raw: string;
  usage: ProviderUsage;
}

export interface ReviewProvider {
  health(signal?: AbortSignal): Promise<{ ok: boolean; models: string[]; error?: string }>;
  invoke(input: {
    profile: ModelProfile;
    prompt: string;
    outputKind: ReviewOutputKind;
    allowedFiles?: string[];
    signal?: AbortSignal;
  }): Promise<ProviderResponse>;
}

function findingProperties(allowedFiles?: string[]) {
  return {
    sourceWorkItemIds: { type: "array", items: { type: "string" } },
    file: allowedFiles?.length ? { type: "string", enum: [...new Set(allowedFiles)] } : { type: "string" },
    line: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    category: { type: "string", enum: ["correctness", "security", "performance", "contract"] },
    title: { type: "string" },
    description: { type: "string" },
    suggestion: { type: "string" },
    primarySymbol: { type: "string" },
    ruleId: { type: "string" },
    candidateConfidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceRequests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "reason"],
        properties: {
          kind: {
            type: "string",
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
          symbol: { type: "string" },
          pathHint: { type: "string" },
          query: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  };
}

function outputSchema(kind: ReviewOutputKind, allowedFiles?: string[]) {
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
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "candidates"],
    properties: {
      summary: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "sourceWorkItemIds",
            "file",
            "line",
            "severity",
            "category",
            "title",
            "description",
            "candidateConfidence",
            "evidenceRequests",
          ],
          properties: findingProperties(allowedFiles),
        },
      },
    },
  };
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

  async invoke(input: {
    profile: ModelProfile;
    prompt: string;
    outputKind: ReviewOutputKind;
    allowedFiles?: string[];
    signal?: AbortSignal;
  }): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Ollama request timed out")),
      input.profile.inference.timeoutMs,
    );
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.config.base_url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.profile.model,
          prompt: input.prompt,
          stream: false,
          think: input.profile.inference.thinking,
          format: outputSchema(input.outputKind, input.allowedFiles),
          options: {
            temperature: input.profile.inference.temperature,
            num_ctx: input.profile.contextTokens,
            num_predict: input.profile.requestedOutputTokens,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body: any = await response.json();
      return {
        raw: String(body.response ?? ""),
        usage: {
          inputTokens: Number(body.prompt_eval_count ?? 0),
          outputTokens: Number(body.eval_count ?? 0),
        },
      };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}
