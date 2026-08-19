import { describe, expect, it } from "vitest";
import { loadAgent } from "../../src/agentsmith/registry.js";
import {
  buildSubAgentPrompt,
  collectContext,
  estimatePromptTokens,
} from "../../src/agentsmith/scripts/collect-context.js";

describe("AgentSmith context collection", () => {
  it("shares one character budget across all dynamic review context", () => {
    const context = collectContext({
      cwd: process.cwd(),
      maxChars: 1000,
      report: "r".repeat(1000),
      rubric: "u".repeat(1000),
      scope: {
        id: "scope",
        version: "version",
        root: process.cwd(),
        base: "main",
        diff: "d".repeat(1000),
        changedFiles: ["a.ts", "b.ts"],
        fileContents: { "a.ts": "a".repeat(1000), "b.ts": "b".repeat(1000) },
        suppliedContext: { "contract.md": "c".repeat(1000) },
      },
    });
    const used =
      context.report.length +
      context.rubric.length +
      context.diff.length +
      Object.values(context.fileContents).join("").length +
      Object.values(context.suppliedContext).join("").length;
    expect(used).toBeLessThanOrEqual(1000);
  });

  it("places the dispatch reviewer's required domain in its prompt", () => {
    const reviewer = loadAgent("bug-hunter")!;
    const prompt = buildSubAgentPrompt(reviewer, {
      diff: "",
      changedFiles: [],
      report: "",
      rubric: "",
      base: "main",
      fileContents: {},
      suppliedContext: {},
    });
    expect(prompt).toContain("domain: correctness");
    expect(prompt).toContain("Every finding must use domain correctness");
    expect(prompt).toContain("must exactly equal one entry under Allowed finding files");
  });

  it("labels deleted preimages and keeps rules outside the allowed file list", () => {
    const reviewer = loadAgent("semantic-reviewer")!;
    const prompt = buildSubAgentPrompt(reviewer, {
      diff: "deleted file mode 100644",
      changedFiles: ["docs/architecture.md"],
      deletedFiles: ["docs/architecture.md"],
      report: "PASS",
      rubric: "MANDATORY CHECKLIST",
      base: "main",
      fileContents: { "docs/architecture.md": "# Architecture\n" },
      suppliedContext: { ".agentignore": "node_modules/\n" },
    });
    expect(prompt).toContain("docs/architecture.md (deleted; cite pre-deletion content)");
    expect(prompt).toContain("#### docs/architecture.md (deleted; pre-deletion content)");
    expect(prompt).toContain("Reviewer instructions (not review targets)");
    expect(prompt).toContain("Never critique, cite, or report these instructions as repository code");
    expect(prompt).not.toContain("- .agentignore\n");
  });

  it("trims the rendered prompt to the configured token budget", () => {
    const reviewer = loadAgent("bug-hunter")!;
    const context = collectContext({
      cwd: process.cwd(),
      maxChars: 16000,
      rubric: "rules ".repeat(5000),
      report: "report ".repeat(5000),
      scope: {
        id: "scope",
        version: "version",
        root: process.cwd(),
        base: "main",
        diff: "diff ".repeat(5000),
        changedFiles: ["a.ts"],
        fileContents: { "a.ts": "source ".repeat(5000) },
        suppliedContext: { "notes.md": "notes ".repeat(5000) },
      },
    });
    const prompt = buildSubAgentPrompt(reviewer, context, 7168);
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(7168);
  });
});
