import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { captureReviewScope } from "../../src/agentsmith/scope.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
describe("ReviewScope", () => {
  it("freezes committed, staged, unstaged, and untracked content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "tracked.ts"), "export const value = 1;\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      fs.writeFileSync(path.join(root, "tracked.ts"), "export const value = 2;\n");
      fs.writeFileSync(path.join(root, "new.rs"), "fn main() {}\n");
      fs.writeFileSync(path.join(root, "deleted.md"), "# Architecture\n\nLayering rules\n");
      git(root, "add", "deleted.md");
      git(root, "commit", "-m", "add deleted fixture");
      fs.unlinkSync(path.join(root, "deleted.md"));
      const scope = captureReviewScope({ root });
      expect(scope.base).toBeNull();
      expect(scope.changedFiles).toEqual(["deleted.md", "new.rs", "tracked.ts"]);
      expect(scope.changeSources).toMatchObject({
        "deleted.md": ["working-tree"],
        "new.rs": ["untracked"],
        "tracked.ts": ["working-tree"],
      });
      expect(scope.deletedFiles).toEqual(["deleted.md"]);
      expect(scope.manifest.find((item) => item.path === "new.rs")?.changeKind).toBe("added");
      expect(scope.manifest.find((item) => item.path === "tracked.ts")?.changeKind).toBe("modified");
      expect(scope.diff).toContain("new file mode");
      expect(scope.diff).toContain("deleted file mode");
      expect(scope.fileContents["deleted.md"]).toContain("Layering rules");
      expect(scope.fileContents["tracked.ts"]).toContain("value = 2");
      const frozen = scope.fileContents["tracked.ts"];
      fs.writeFileSync(path.join(root, "tracked.ts"), "changed later\n");
      expect(scope.fileContents["tracked.ts"]).toBe(frozen);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps tracked files with addition-only hunks classified as modified", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-addition-only-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "app.ts"), "export const first = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      fs.appendFileSync(path.join(root, "app.ts"), "export const second = true;\n");

      const scope = captureReviewScope({ root });
      expect(scope.manifest).toContainEqual(
        expect.objectContaining({ path: "app.ts", changeKind: "modified", additions: 1, deletions: 0 }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes committed branch changes only when a base is explicit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-explicit-base-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "base.ts"), "export const base = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      git(root, "switch", "-c", "feature");
      fs.writeFileSync(path.join(root, "feature.ts"), "export const feature = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "feature");

      expect(captureReviewScope({ root }).changedFiles).toEqual([]);
      const explicit = captureReviewScope({ root, base: "main" });
      expect(explicit.changedFiles).toEqual(["feature.ts"]);
      expect(explicit.changeSources["feature.ts"]).toEqual(["committed-delta"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes the merge-base preimage of a deletion committed on the review branch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-branch-delete-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "contract.md"), "# Contract\n\nDependency direction\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      git(root, "switch", "-c", "feature");
      fs.unlinkSync(path.join(root, "contract.md"));
      git(root, "add", "-u");
      git(root, "commit", "-m", "delete contract");
      const scope = captureReviewScope({ root, base: "main" });
      expect(scope.changedFiles).toEqual(["contract.md"]);
      expect(scope.deletedFiles).toEqual(["contract.md"]);
      expect(scope.fileContents["contract.md"]).toContain("Dependency direction");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies captured eval inputs as generated replay data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-eval-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      const directory = path.join(root, "evals", "agentsmith", "case-one");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "input.json"), '{"schemaVersion":3}\n');
      const scope = captureReviewScope({ root });
      expect(scope.manifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "evals/agentsmith/case-one/input.json", generated: true }),
        ]),
      );
      expect(scope.omissions).toContainEqual({
        kind: "file",
        id: "evals/agentsmith/case-one/input.json",
        reason: "generated",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes frozen fixture contents beneath a MatrixCore ignore boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-scope-ignore-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      fs.writeFileSync(path.join(root, "README.md"), "base\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "base");
      const fixture = path.join(root, "evals", "case", "fixture");
      fs.mkdirSync(fixture, { recursive: true });
      fs.writeFileSync(path.join(fixture, ".matrixcore-ignore"), "");
      fs.writeFileSync(path.join(fixture, "source.ts"), "export const frozen = true;\n");
      fs.writeFileSync(path.join(root, "case.yaml"), "status: active\n");
      expect(captureReviewScope({ root }).changedFiles).toEqual(["case.yaml"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
