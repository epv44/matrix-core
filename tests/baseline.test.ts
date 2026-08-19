import { describe, it, expect } from "vitest";
import { diffBaseline, hashConfig } from "../src/core/baseline.js";
describe("baseline", () => {
  it("hashes config deterministically", () => {
    const h1 = hashConfig({ a: 1, b: 2 });
    const h2 = hashConfig({ a: 1, b: 2 });
    expect(h1).toBe(h2);
    expect(h1.length).toBe(12);
  });
  it("diffs metrics", () => {
    const base = { version: 1, timestamp: new Date().toISOString(), metrics: { cov: 80, err: 0 } } as any;
    const cur = { cov: 85, err: 2 } as any;
    const d = diffBaseline(cur, base);
    expect(d.find((x) => x.metric === "cov")?.delta).toBe(5);
  });
});
