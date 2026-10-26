import { describe, expect, it } from "vitest";
import { deriveControlFlowDeltas } from "../../src/agentsmith/control-flow-delta.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

const symbol = {
  file: "src/routes.ts",
  provider: "typescript-compiler" as const,
  kind: "function" as const,
  name: "deleteUser",
  qualifiedName: "deleteUser",
  startLine: 3,
  endLine: 7,
  contentHash: "routes",
};

function item(overrides: Partial<ReviewWorkItem> = {}): ReviewWorkItem {
  return {
    id: "interaction:routes",
    kind: "interaction",
    primarySymbols: [symbol],
    relatedSymbols: [],
    graphEdges: [],
    rules: [],
    code: [{
      id: "routes",
      file: "src/routes.ts",
      startLine: 1,
      endLine: 7,
      symbol: "deleteUser",
      content: `export interface Session {\n  role: "admin" | "member";\n}\nexport function deleteUser(session: Session | null, userId: string): string {\n  const role = session?.role;\n  if (!session && role !== "admin") throw new Error("forbidden");\n  return \`deleted:\${userId}\`;\n}`,
      changed: true,
      score: 100,
      reason: "changed",
      estimatedTokens: 80,
    }],
    promptVisibleRanges: [{ file: "src/routes.ts", start: 1, end: 7 }],
    estimatedTokens: 200,
    ...overrides,
  };
}

const authDiff = `diff --git a/src/routes.ts b/src/routes.ts
--- a/src/routes.ts
+++ b/src/routes.ts
@@ -3,5 +3,6 @@
 export function deleteUser(session: Session | null, userId: string): string {
-  if (!session || session.role !== "admin") throw new Error("forbidden");
+  const role = session?.role;
+  if (!session && role !== "admin") throw new Error("forbidden");
   return \`deleted:\${userId}\`;
 }`;

describe("control-flow delta", () => {
  it("proves the newly admitted finite member state for a changed nullable guard", () => {
    expect(deriveControlFlowDeltas({ diff: authDiff, workItem: item() })).toEqual([
      expect.objectContaining({
        file: "src/routes.ts",
        startLine: 5,
        state: 'session present, role = "member"',
        previousOutcome: "blocked",
        currentOutcome: "passes",
      }),
    ]);
  });

  it("emits no delta when a syntactic rewrite preserves finite-state behavior", () => {
    const diff = authDiff.replace('!session || session.role !== "admin"', 'session.role !== "admin" || !session').replace('!session && role !== "admin"', 'role !== "admin" || !session');
    expect(deriveControlFlowDeltas({ diff, workItem: item() })).toEqual([]);
  });

  it("does not emit a delta when the changed guard is outside prompt-visible code", () => {
    expect(deriveControlFlowDeltas({
      diff: authDiff,
      workItem: item({ promptVisibleRanges: [{ file: "src/routes.ts", start: 1, end: 4 }] }),
    })).toEqual([]);
  });

  it("does not guess through unsupported expressions", () => {
    const diff = authDiff.replace('!session || session.role !== "admin"', 'canDelete(session)').replace('!session && role !== "admin"', 'canDelete(session, role)');
    expect(deriveControlFlowDeltas({ diff, workItem: item() })).toEqual([]);
  });
});
