import type { AgentSmithConfig, ModelProfile } from "../core/types.js";

export type ReviewOutputKind = "candidates" | "specialist" | "scout" | "verification" | "citation-selection";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderCompletionMetadata {
  model: string;
  done: boolean | null;
  doneReason: string | null;
  totalDurationNs: number | null;
  loadDurationNs: number | null;
  promptEvalDurationNs: number | null;
  evalDurationNs: number | null;
}

export interface ProviderResponse {
  raw: string;
  usage: ProviderUsage;
  completion?: ProviderCompletionMetadata;
}

export interface ReviewProvider {
  health(signal?: AbortSignal): Promise<{ ok: boolean; models: string[]; error?: string }>;
  invoke(input: {
    profile: ModelProfile;
    prompt: string;
    outputKind: ReviewOutputKind;
    allowedFiles?: string[];
    maxCandidates?: number;
    evidenceSelectorKeys?: string[];
    signal?: AbortSignal;
  }): Promise<ProviderResponse>;
}

function compactCandidateProperties(
  allowedFiles?: string[],
  evidenceSelectorKeys?: string[],
) {
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
          ...(evidenceSelectorKeys !== undefined ? { selector: { type: "string", enum: evidenceSelectorKeys } } : {}),
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

function outputSchema(
  kind: ReviewOutputKind,
  allowedFiles?: string[],
  maxCandidates = 2,
  _evidenceSelectorKeys?: string[],
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
  const candidateOutput = {
    type: "object",
    additionalProperties: false,
    required: kind === "specialist" ? ["summary", "c"] : ["state", "candidates"],
    properties: {
      ...(kind === "specialist"
        ? {
            summary: { type: "string", minLength: 1, maxLength: 1200 },
            c: {
              type: "array",
              maxItems: maxCandidates,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["f", "l", "s", "k", "t", "d", "q", "e"],
                properties: compactCandidateProperties(allowedFiles),
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
                required: ["file", "line", "severity", "category", "trigger", "invariant", "impact", "confidence"],
                properties: {
                  file: allowedFiles?.length ? { type: "string", enum: [...new Set(allowedFiles)] } : { type: "string", minLength: 1 },
                  line: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                  category: { type: "string", enum: ["correctness", "security", "performance", "contract"] },
                  trigger: { type: "string", minLength: 1, maxLength: 160 },
                  invariant: { type: "string", minLength: 1, maxLength: 240 },
                  impact: { type: "string", minLength: 1, maxLength: 240 },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
              },
            },
          }),
    },
  };
  return candidateOutput;
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
    maxCandidates?: number;
    evidenceSelectorKeys?: string[];
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
          format: outputSchema(
            input.outputKind,
            input.allowedFiles,
            input.maxCandidates,
            input.evidenceSelectorKeys,
          ),
          keep_alive: `${Math.ceil(this.config.maxDurationMs / 60_000) + 5}m`,
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
        completion: {
          model: String(body.model ?? input.profile.model),
          done: typeof body.done === "boolean" ? body.done : null,
          doneReason: typeof body.done_reason === "string" ? body.done_reason : null,
          totalDurationNs: Number.isFinite(body.total_duration) ? Number(body.total_duration) : null,
          loadDurationNs: Number.isFinite(body.load_duration) ? Number(body.load_duration) : null,
          promptEvalDurationNs: Number.isFinite(body.prompt_eval_duration) ? Number(body.prompt_eval_duration) : null,
          evalDurationNs: Number.isFinite(body.eval_duration) ? Number(body.eval_duration) : null,
        },
      };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}
