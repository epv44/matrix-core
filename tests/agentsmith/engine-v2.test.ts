import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { captureReviewScope } from "../../src/agentsmith/scope.js";
import { executeReviewEngine } from "../../src/agentsmith/engine.js";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

describe("unified v2 verification pipeline", () => {
  it("does not publish a speculative claim anchored outside changed code", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-engine-v2-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: engine-v2\nreview:\n  agentsmith: true\n",
      );
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"engine-v2","private":true}\n');
      fs.writeFileSync(path.join(root, "src.ts"), "export function value() { return 1; }\n");
      fs.writeFileSync(path.join(root, ".agentignore"), "node_modules/\n");
      git(root, "init", "-q");
      git(root, "config", "user.email", "x@y.z");
      git(root, "config", "user.name", "x");
      git(root, "add", ".");
      git(root, "commit", "-qm", "base");
      fs.writeFileSync(path.join(root, "src.ts"), "export function value() { return 2; }\n");
      const scope = captureReviewScope({ root, base: "HEAD" });
      let verifierCalls = 0;
      const provider: ReviewProvider = {
        health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M"] }),
        invoke: async (input) => {
          if (input.outputKind === "verification") verifierCalls++;
          return input.outputKind === "verification"
            ? {
                raw: '{"verdict":"verified","confidence":1,"supportingEvidenceIds":[]}',
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            : {
                raw: JSON.stringify({
                  summary: "speculation",
                  candidates: [
                    {
                      sourceWorkItemIds: [],
                      file: ".agentignore",
                      line: 1,
                      severity: "critical",
                      category: "contract",
                      title: "Checklist is wrong",
                      description: "The instruction might conflict with code.",
                      candidateConfidence: 0.8,
                      evidenceRequests: [],
                    },
                  ],
                }),
                usage: { inputTokens: 1, outputTokens: 1 },
              };
        },
      };
      const config = agentSmithConfigFromPolicy(true);
      config.cache = false;
      const { result, execution } = await executeReviewEngine({
        root,
        version: scope.version,
        scope,
        config,
        provider,
      });
      expect(result).toMatchObject({ status: "completed", outcome: "clear", findings: [] });
      expect(execution.verification).toEqual([
        expect.objectContaining({
          verdict: "rejected",
          reasoningSummary: expect.stringContaining("outside the changed"),
        }),
      ]);
      expect(verifierCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
