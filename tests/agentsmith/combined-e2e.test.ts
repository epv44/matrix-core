import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runQualityCompletion, runQualityReview } from "../../src/core/review.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";

class FakeProvider implements ReviewProvider {
  calls = 0;
  async health() {
    return { ok: true, models: ["qwen3.5:9b-q4_K_M"] };
  }
  async invoke(input: Parameters<ReviewProvider["invoke"]>[0]) {
    this.calls++;
    if (input.outputKind === "verification")
      return {
        raw: '{"verdict":"verified","confidence":1,"supportingEvidenceIds":[]}',
        usage: { inputTokens: 20, outputTokens: 5 },
      };
    if (input.outputKind === "scout") return { raw: '{"hotspots":[]}', usage: { inputTokens: 20, outputTokens: 5 } };
    const file = input.prompt.includes("defect.txt") ? "defect.txt" : "quality.yaml";
    const line = file === "defect.txt" ? 1 : 4;
    return {
      raw: JSON.stringify({
        c: [
          {
            f: file,
            l: line,
            s: "high",
            k: "correctness",
            t: "Fixture defect",
            d: "The changed value causes a concrete failure.",
            g: "Guard the value.",
            q: 0.9,
            e: [],
          },
        ],
      }),
      usage: { inputTokens: 20, outputTokens: 5 },
    };
  }
}
function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
describe("combined review e2e with fake provider", () => {
  it("runs the unified partitioned pipeline and caches the verified result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-combined-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        `version: 2\nproject: combined-review\nreview:\n  agentsmith: true\n`,
      );
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "README.md"), "base\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      fs.writeFileSync(path.join(root, "defect.txt"), "possible null dereference\n");
      const provider = new FakeProvider();
      const first = await runQualityReview({ cwd: root, mode: "full", base: "main", provider });
      expect(first.gate.status).toBe("PASS");
      expect(first.review).toMatchObject({
        schemaVersion: 3,
        reviewPath: "generic",
        mode: "partitioned",
        outcome: "findings",
      });
      expect(first.review.findings[0].confidence).toBe("verified");
      expect(first.passed).toBe(true);
      expect(provider.calls).toBe(2);
      const second = await runQualityReview({ cwd: root, mode: "full", base: "main", provider });
      expect(second.review.cacheHit).toBe(true);
      expect(provider.calls).toBe(2);
      fs.appendFileSync(path.join(root, "defect.txt"), "changed\n");
      const third = await runQualityReview({ cwd: root, mode: "full", base: "main", provider });
      expect(third.review.cacheHit).not.toBe(true);
      expect(provider.calls).toBe(4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("uses project configuration to include or omit AgentSmith during completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-completion-"));
    try {
      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: completion\nreview:\n  agentsmith: false\n",
      );
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      const disabled = await runQualityCompletion({ cwd: root, mode: "full", provider: new FakeProvider() });
      expect(disabled).toMatchObject({
        passed: true,
        deterministicPassed: true,
        completionAllowed: true,
        reviewEnabled: false,
        review: null,
        advisoryReview: { status: "disabled", verdict: null },
      });

      fs.writeFileSync(
        path.join(root, "quality.yaml"),
        "version: 2\nproject: completion\nreview:\n  agentsmith: true\n",
      );
      const provider = new FakeProvider();
      const enabled = await runQualityCompletion({ cwd: root, mode: "full", provider });
      expect(enabled.reviewEnabled).toBe(true);
      expect(enabled.review?.findings.length).toBeGreaterThan(0);
      expect(enabled.passed).toBe(true);
      expect(enabled).toMatchObject({
        deterministicPassed: true,
        completionAllowed: true,
        advisoryReview: { status: "completed", verdict: "findings" },
      });
      expect(provider.calls).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
