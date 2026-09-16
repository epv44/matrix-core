import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const cliSource = fs.readFileSync(path.join(repositoryRoot, "tools/agentsmith-evals/src/cli.ts"), "utf8");

describe("AgentSmith CLI migration", () => {
  it("exposes the root eval entrypoint without the legacy suite command", () => {
    expect(packageJson.scripts?.eval).toBe("tsx tools/agentsmith-evals/src/cli.ts");
    expect(packageJson.scripts?.["eval:agentsmith"]).toBeUndefined();
    expect(cliSource).toContain('.option("--target <target>"');
    expect(cliSource).toContain('.option("--suite <suite>"');
    expect(cliSource).toContain('.option("--tier <tier>"');
    expect(cliSource).toContain('.option("--stage <stage...>"');
    expect(cliSource).toContain('.option("--repeat <count>"');
    expect(cliSource).not.toContain('.command("suite")');
    expect(cliSource).not.toContain("runCanonicalEvalSuite");
  });

  it("honors the requested HTML output path", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentsmith-html-"));
    const input = path.join(temporaryRoot, "suite.json");
    const output = path.join(temporaryRoot, "nested", "suite.html");
    try {
      fs.writeFileSync(input, JSON.stringify({ suite: "component", evalStatus: "pass" }));
      execFileSync(
        process.execPath,
        ["--import", "tsx", path.join(repositoryRoot, "tools/agentsmith-evals/src/cli.ts"), "html", input, "--output", output],
        { cwd: repositoryRoot, stdio: "pipe" },
      );
      expect(fs.existsSync(output)).toBe(true);
      expect(fs.readFileSync(output, "utf8")).toContain("AgentSmith Evaluation Report");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
