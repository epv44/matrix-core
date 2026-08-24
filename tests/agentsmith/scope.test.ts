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
      expect(scope.changedFiles).toEqual(["deleted.md", "new.rs", "tracked.ts"]);
      expect(scope.deletedFiles).toEqual(["deleted.md"]);
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
});
