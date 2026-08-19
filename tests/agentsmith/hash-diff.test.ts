import { describe, expect, it } from "vitest";
import { hashDiff } from "../../src/agentsmith/scripts/hash-diff.js";

describe("hashDiff", () => {
  it("is deterministic", () => {
    const opts = { diff: "--- a/x\n+++ b/x\n+change", config: "version: 1" };
    expect(hashDiff(opts)).toBe(hashDiff(opts));
  });

  it("changes when the diff changes", () => {
    const base = hashDiff({ diff: "one" });
    expect(hashDiff({ diff: "two" })).not.toBe(base);
  });

  it("changes when the config changes", () => {
    const base = hashDiff({ diff: "one", config: "a" });
    expect(hashDiff({ diff: "one", config: "b" })).not.toBe(base);
  });

  it("is stable across an empty config", () => {
    expect(hashDiff({ diff: "x" })).toBe(hashDiff({ diff: "x", config: "" }));
  });
});
