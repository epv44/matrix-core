import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OllamaProvider, OpenAIResponsesProvider, VllmProvider, createReviewProvider } from "../../src/agentsmith/provider.js";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";

afterEach(() => vi.unstubAllGlobals());

describe("OllamaProvider v2", () => {
  it("uses locked model inference settings and constrains candidate locations", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const profile = config.model_profiles[0];
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "qwen3.5:9b-q4_K_M",
            response: '{"c":[]}',
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 3,
            total_duration: 100,
            load_duration: 20,
            prompt_eval_duration: 30,
            eval_duration: 50,
          }),
        );
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile,
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts", "docs/deleted.md", "src/a.ts"],
      maxCandidates: 2,
    });
    const candidates = requestBody.format.properties.candidates;
    const item = candidates.items;
    expect(requestBody.format.required).toEqual(["state", "candidates"]);
    expect(candidates.maxItems).toBe(2);
    expect(item.required).toEqual(expect.arrayContaining(["file", "line", "category", "trigger", "invariant", "impact", "confidence"]));
    expect(item.properties.file).toEqual({ type: "string", enum: ["src/a.ts", "docs/deleted.md"] });
    expect(item.properties.impact.maxLength).toBe(240);
    expect(item.properties.trigger.maxLength).toBe(160);
    expect(requestBody.model).toBe(profile.model);
    expect(requestBody.options).toMatchObject({
      num_ctx: profile.contextTokens,
      num_predict: profile.requestedOutputTokens,
    });
    expect(requestBody.options.top_p).toBeUndefined();
    expect(requestBody.options.top_k).toBeUndefined();
    expect(requestBody.keep_alive).toBe("35m");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(response.completion).toEqual({
      model: "qwen3.5:9b-q4_K_M",
      done: true,
      doneReason: "stop",
      totalDurationNs: 100,
      loadDurationNs: 20,
      promptEvalDurationNs: 30,
      evalDurationNs: 50,
    });
  });

  it("constrains rule-bound candidates to the task's visible rule IDs", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ response: '{"state":"no_finding","candidates":[]}' }));
    }));
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0], prompt: "review", outputKind: "candidates",
      candidateArm: "rule-bound-classification", allowedRuleIds: ["security.authorization-boundary"],
    });
    const candidate = requestBody.format.properties.candidates.items;
    expect(candidate.required).toContain("basisRuleId");
    expect(candidate.properties.basisRuleId).toEqual({ type: "string", enum: ["security.authorization-boundary"] });
  });

  it("limits witness candidates to host-owned references and model-owned impact", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ response: '{"state":"no_finding","candidates":[]}' }));
    }));
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      candidateArm: "host-referenced-witness",
      allowedRuleIds: ["security.authorization-boundary"],
      allowedWitnessKeys: ["deleteUser.guard-4.state-1"],
    });
    const candidate = requestBody.format.properties.candidates.items;
    expect(candidate.required).toEqual([
      "file", "line", "witnessKey", "basisRuleId", "impact", "confidence",
    ]);
    expect(candidate.properties.witnessKey).toEqual({
      type: "string",
      enum: ["deleteUser.guard-4.state-1"],
    });
    expect(candidate.properties.basisRuleId).toEqual({
      type: "string",
      enum: ["security.authorization-boundary"],
    });
    for (const hostOwned of ["severity", "category", "trigger", "invariant", "title", "evidenceRequests", "id"])
      expect(candidate.properties).not.toHaveProperty(hostOwned);
  });

  it("passes configured top-p and top-k sampling values", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const profile = {
      ...config.model_profiles[0],
      inference: { ...config.model_profiles[0].inference, temperature: 0.6, topP: 0.95, topK: 20 },
    };
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );
    await new OllamaProvider(config).invoke({ profile, prompt: "review", outputKind: "candidates" });
    expect(requestBody.options).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20 });
  });

  it("uses the focused verification schema", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ response: '{"verdict":"rejected","confidence":1,"supportingEvidenceIds":[]}' }),
        );
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "verify",
      outputKind: "verification",
    });
    expect(requestBody.format.properties.verdict.enum).toEqual([
      "verified",
      "likely",
      "rejected",
      "insufficient_evidence",
    ]);
  });

  it("uses thinking without structured format only for the diagnostic inference mode", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"state":"no_finding","candidates":[]}', thinking: "trace" }));
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      inferenceMode: "thinking-no-format",
    });
    expect(requestBody.think).toBe(true);
    expect(requestBody.format).toBeUndefined();
  });

  it("uses native Ollama chat thinking with the strict schema for thinking-structured", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestUrl = "";
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requestUrl = url;
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "qwen3.5:9b-q4_K_M",
            message: {
              content: '{"state":"no_finding","candidates":[]}',
              thinking: "bounded trace",
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 3034,
            total_duration: 100,
          }),
        );
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      inferenceMode: "thinking-structured",
      systemPrompt: "bounded instructions",
      inferenceOverrides: { outputTokens: 4096 },
    });
    expect(requestUrl).toBe(`${config.base_url}/api/chat`);
    expect(requestBody.messages).toEqual([
      { role: "system", content: "bounded instructions" },
      { role: "user", content: "review" },
    ]);
    expect(requestBody.think).toBe(true);
    expect(requestBody.format.properties.candidates.maxItems).toBe(2);
    expect(requestBody.options.num_predict).toBe(4096);
    expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
    expect(response.thinking).toBe("bounded trace");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3034 });
  });

  it("uses generate with a hard reasoning budget and records the applied Ollama budget", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestUrl = "";
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requestUrl = url;
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          model: "qwen3.5:9b-q4_K_M",
          response: '{"state":"no_finding","candidates":[]}',
          thinking: "bounded trace",
          done: true,
          done_reason: "stop",
          think_budget: 2048,
          think_budget_tokens: 2048,
          prompt_eval_count: 12,
          eval_count: 2100,
        }));
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      inferenceMode: "thinking-structured",
      systemPrompt: "bounded instructions",
      inferenceOverrides: { contextTokens: 6144, outputTokens: 3072, thinkingTokens: 2048 },
    });
    expect(requestUrl).toBe(`${config.base_url}/api/generate`);
    expect(requestBody).toMatchObject({
      prompt: "review",
      system: "bounded instructions",
      think: true,
      options: { num_ctx: 6144, num_predict: 3072, think_budget: 2048 },
    });
    expect(requestBody.messages).toBeUndefined();
    expect(requestBody.format.properties.candidates).toBeDefined();
    expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
    expect(response.thinking).toBe("bounded trace");
    expect(response.completion).toMatchObject({ thinkBudget: 2048, thinkBudgetTokens: 2048 });
  });

  it("streams thinking chunks and persists them in order", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const profile = config.model_profiles[0];
    const traceDir = await mkdtemp(path.join(os.tmpdir(), "matrixcore-thinking-"));
    const tracePath = path.join(traceDir, "request.ndjson");
    const encoder = new TextEncoder();
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        const chunks = [
          JSON.stringify({ message: { thinking: "check " }, done: false }) + "\n",
          JSON.stringify({ message: { thinking: "guard", content: '{"state":"no_finding",' }, done: false }) + "\n",
          JSON.stringify({ message: { content: '"candidates":[]}' }, done: true, done_reason: "stop", eval_count: 7 }),
        ];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      }),
    );
    try {
      const response = await new OllamaProvider(config).invoke({
        profile,
        prompt: "review",
        outputKind: "candidates",
        inferenceMode: "thinking-structured",
        stream: true,
        streamTracePath: tracePath,
      });
      expect(requestBody.stream).toBe(true);
      expect(response.thinking).toBe("check guard");
      expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
      expect(response.usage.outputTokens).toBe(7);
      const trace = await readFile(tracePath, "utf8");
      expect(trace).toContain('"sequence":0');
      expect(trace).toContain('"thinkingDelta":"check "');
      expect(trace).toContain('"sequence":2');
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  });

  it("assembles bounded generate-stream thinking and content", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const encoder = new TextEncoder();
    let requestUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestUrl = url;
        const chunks = [
          JSON.stringify({ thinking: "check ", done: false }) + "\n",
          JSON.stringify({ thinking: "guard", response: '{"state":"no_finding",', done: false }) + "\n",
          JSON.stringify({ response: '"candidates":[]}', done: true, done_reason: "stop", think_budget: 64, think_budget_tokens: 64, eval_count: 80 }) + "\n",
        ];
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }));
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      inferenceMode: "thinking-structured",
      inferenceOverrides: { thinkingTokens: 64 },
      stream: true,
    });
    expect(requestUrl).toBe(`${config.base_url}/api/generate`);
    expect(response.thinking).toBe("check guard");
    expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
    expect(response.completion).toMatchObject({ thinkBudget: 64, thinkBudgetTokens: 64 });
  });

  it("omits the system prompt for baseline and preserves the structured contract for a treatment prompt", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ response: '{"state":"no_finding","candidates":[]}' }));
      }),
    );
    const provider = new OllamaProvider(config);
    const common = {
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates" as const,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
    };
    await provider.invoke(common);
    await provider.invoke({ ...common, systemPrompt: "branch analysis instructions" });
    expect(requests[0].system).toBeUndefined();
    expect(requests[1].system).toBe("branch analysis instructions");
    expect(requests[0].think).toBe(false);
    expect(requests[1].think).toBe(false);
    expect(requests[0].format).toEqual(requests[1].format);
  });

  it("applies per-call inference budget overrides", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: "{}" }));
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "reason",
      outputKind: "candidates",
      inferenceMode: "thinking-no-format",
      inferenceOverrides: { contextTokens: 32_768, outputTokens: 16_384 },
    });
    expect(requestBody.think).toBe(true);
    expect(requestBody.format).toBeUndefined();
    expect(requestBody.options).toMatchObject({ num_ctx: 32_768, num_predict: 16_384 });
  });

  it("does not expose evidence selectors in the bounded candidate schema", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      evidenceSelectorKeys: ["primary-1.definition", "primary-1.implementation"],
    });
    const candidate = requestBody.format.properties.candidates.items;
    expect(candidate.properties.evidence).toBeUndefined();
    expect(candidate.properties.selector).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain("primary-1.definition");
  });

  it("preserves the strong specialist path without bounded selector IDs", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    const prompt = "strong specialist review prompt";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"summary":"reviewed","c":[]}' }));
      }),
    );

    await new OllamaProvider(config).invoke({
      profile: config.model_profiles.find((item) => item.reviewCapability === "strong")!,
      prompt,
      outputKind: "specialist",
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
    });

    const evidence = requestBody.format.properties.c.items.properties.e.items;
    expect(requestBody.prompt).toBe(prompt);
    expect(evidence.required).toEqual(["k", "v", "r"]);
    expect(evidence.properties.i).toBeUndefined();
    expect(evidence.properties.v).toMatchObject({ type: "string", minLength: 1 });
    expect(evidence.properties.m.enum).toEqual(["symbol", "literal"]);
    expect(evidence.properties.p).toBeDefined();
  });

  it("keeps readable selector names in the bounded schema rather than exposing internal hashes", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );

    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "inspect the producer selector",
      outputKind: "candidates",
      allowedFiles: ["src/producer.ts"],
      maxCandidates: 1,
      evidenceSelectorKeys: ["primary-1.definition"],
    } as any);

    const candidate = requestBody.format.properties.candidates.items;
    expect(candidate.properties.evidence).toBeUndefined();
    expect(candidate.properties.selector).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain("primary-1.definition");
    expect(JSON.stringify(requestBody.format)).not.toMatch(/locator-[a-f0-9]{20}/);
  });

  it("keeps the bounded schema valid when a work item has no selectors", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );

    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review without selectors",
      outputKind: "candidates",
      candidateArm: "host-defaults",
      evidenceSelectorKeys: [],
      maxCandidates: 1,
    });

    const evidence = requestBody.format.properties.c.items.properties.e.items;
    expect(evidence.required).toEqual(["selector", "r"]);
    expect(evidence.properties.selector).toEqual({ type: "string", minLength: 1 });
    expect(JSON.stringify(requestBody.format)).not.toContain('"enum":[]');
  });
});

describe("VllmProvider", () => {
  it("requests bounded Qwen reasoning with final JSON schema output", async () => {
    const config = { ...agentSmithConfigFromPolicy(true), provider: "vllm", base_url: "http://127.0.0.1:8000/v1" };
    const profile = config.model_profiles[0];
    let requestUrl = "";
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requestUrl = url;
        requestBody = JSON.parse(String(init.body));
        if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ count: 12 }));
        return new Response(JSON.stringify({
          model: profile.model,
          choices: [{ message: { reasoning: "check guard", content: '{"state":"no_finding","candidates":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 8, accepted_prediction_tokens: 20 } },
        }));
      }),
    );
    const response = await new VllmProvider(config).invoke({
      profile,
      prompt: "review",
      outputKind: "candidates",
      inferenceMode: "thinking-structured",
        inferenceOverrides: { outputTokens: 7000, thinkingTokens: 512 },
    });
    expect(requestUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(requestBody.thinking_token_budget).toBe(512);
    expect(requestBody.max_tokens).toBe(7000);
    expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(requestBody.response_format).toMatchObject({ type: "json_schema" });
    expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
    expect(response.thinking).toBe("check guard");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 20, reasoningTokens: 8, finalContentTokens: 12 });
    expect(response.usage.reasoningTokens).toBe(8);
    expect(response.usage.finalContentTokens).toBe(12);
  });

  it("assembles streamed reasoning and content deltas", async () => {
    const config = { ...agentSmithConfigFromPolicy(true), provider: "vllm", base_url: "http://127.0.0.1:8000/v1" };
    const profile = config.model_profiles[0];
    const traceDir = await mkdtemp(path.join(os.tmpdir(), "matrixcore-vllm-"));
    const tracePath = path.join(traceDir, "request.ndjson");
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ count: 3 }));
        const chunks = [
          'data: {"choices":[{"delta":{"reasoning":"check "}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning":"guard","content":"{\\"state\\":\\"no_finding\\","}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"\\"candidates\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":8}}\n\n',
          "data: [DONE]\n\n",
        ];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    try {
      const response = await new VllmProvider(config).invoke({
        profile,
        prompt: "review",
        outputKind: "candidates",
        inferenceMode: "thinking-structured",
        stream: true,
        streamTracePath: tracePath,
      });
      expect(response.thinking).toBe("check guard");
      expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
      expect(response.completion?.doneReason).toBe("stop");
      expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 8 });
      expect((await readFile(tracePath, "utf8"))).toContain('"provider":"vllm"');
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  });

  it("leaves room for the prompt under vLLM's total context limit", async () => {
    const base = agentSmithConfigFromPolicy(true);
    const config = {
      ...base,
      provider: "vllm",
      base_url: "http://127.0.0.1:8000/v1",
      model_profiles: base.model_profiles.map((profile, index) =>
        index === 0 ? { ...profile, contextTokens: 1024, safetyReserveTokens: 100 } : profile,
      ),
    };
    const profile = config.model_profiles[0];
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ count: 100 }));
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          model: profile.model,
          choices: [{ message: { content: '{"state":"no_finding","candidates":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
      }),
    );
    await expect(new VllmProvider(config).invoke({
      profile,
      prompt: "x".repeat(400),
      outputKind: "candidates",
      inferenceMode: "structured",
      inferenceOverrides: { outputTokens: 8192 },
    })).rejects.toThrow("requested=8192, available=824");
    expect(requestBody).toBeUndefined();
  });
});

describe("OpenAIResponsesProvider diagnostic control", () => {
  it("uses strict structured output and retains only the provider reasoning summary", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const profile = { ...config.model_profiles[0], provider: "openai-responses" as const, model: "gpt-5.6-luna" };
    let requestBody: any;
    let authorization = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      authorization = String((init.headers as Record<string, string>).authorization);
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        id: "resp_test",
        model: "gpt-5.6-luna",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "Checked the branch outcomes." }] },
          { type: "message", content: [{ type: "output_text", text: '{"state":"no_finding","candidates":[]}' }] },
        ],
        usage: { input_tokens: 12, output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 } },
      }));
    }));
    const response = await new OpenAIResponsesProvider({ apiKey: "secret", reasoningEffort: "high" }).invoke({
      profile,
      prompt: "review",
      systemPrompt: "bounded instructions",
      outputKind: "candidates",
      allowedFiles: ["src/routes.ts"],
      maxCandidates: 2,
      inferenceMode: "thinking-structured",
    });
    expect(authorization).toBe("Bearer secret");
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      instructions: "bounded instructions",
      input: "review",
      max_output_tokens: profile.requestedOutputTokens,
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_schema", strict: true } },
    });
    const candidateSchema = requestBody.text.format.schema.properties.candidates.items;
    expect(candidateSchema.required).toContain("endLine");
    expect(candidateSchema.properties.endLine).toEqual({
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
    });
    expect(response.raw).toBe('{"state":"no_finding","candidates":[]}');
    expect(response.thinking).toBeUndefined();
    expect(response.reasoningSummary).toBe("Checked the branch outcomes.");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 20, reasoningTokens: 8, finalContentTokens: 12 });
  });

  it("cannot be selected by the normal provider factory", () => {
    const config = { ...agentSmithConfigFromPolicy(true), provider: "openai-responses" as const };
    expect(() => createReviewProvider(config)).toThrow("eval-only diagnostic runner");
  });
});
