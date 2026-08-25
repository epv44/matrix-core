import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repositoryGraph } from "../src/core/graph/index.js";
import { captureReviewScope } from "../src/agentsmith/scope.js";

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("repository graph", () => {
  it("indexes tracked source, reuses a ready snapshot, and updates changed files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix graph "));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"graph-fixture"}\n');
    fs.writeFileSync(path.join(root, "main.ts"), "export function calculate() { return helper(); }\n");
    fs.writeFileSync(path.join(root, "helper.ts"), "export function helper() { return 1; }\n");
    fs.writeFileSync(path.join(root, "worker.py"), "def worker():\n    return 1\n");
    git(root, "init", "-q");
    git(root, "config", "user.email", "matrix@example.invalid");
    git(root, "config", "user.name", "Matrix");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    const graph = repositoryGraph(root);
    const first = await graph.ensureReady();
    expect(first.state).toBe("READY");
    expect(first.fileCount).toBe(3);
    expect((await graph.ensureReady()).snapshotHash).toBe(first.snapshotHash);
    fs.writeFileSync(path.join(root, "main.ts"), "export function calculate() { return helper() + 1; }\n");
    const scope = captureReviewScope({ root, base: "HEAD" });
    const changed = await graph.getContext(scope, 1000);
    expect(changed.snapshot.state).toBe("READY");
    expect(changed.rendered).toContain("calculate");
    expect(changed.rendered).toContain("Repository graph context");
    const changedKeys = changed.changedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`);
    const edgeKeys = changed.edges.map((edge) => `${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`);
    expect(new Set(changedKeys).size).toBe(changedKeys.length);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(changed.edges.some((edge) => edge.target?.endsWith(":helper") || edge.targetText === "helper")).toBe(true);
    expect(changed.changedSymbols.find((symbol) => symbol.qualifiedName === "calculate")?.provider).toBe(
      "typescript-compiler",
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});
