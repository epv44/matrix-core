import { describe, it, expect } from "vitest";
import { detectMap, detectAll, clearCapabilityCache } from "../src/core/capability.js";
import type { Capability } from "../src/core/types.js";

function cap(name: string): Capability {
  return { name, found: true, required: false };
}

describe("detectMap", () => {
  it("maps binary names to canonical pack keys", () => {
    const m = detectMap([
      cap("ruff"),
      cap("mypy"),
      cap("pytest"),
      cap("tsc"),
      cap("eslint"),
      cap("prettier"),
      cap("vitest"),
      cap("go"),
      cap("golangci-lint"),
      cap("xenon"),
      cap("deptry"),
      cap("sqlfluff"),
    ]);
    expect(m.get("python.ruff")).toBeDefined();
    expect(m.get("ruff")).toBeDefined();
    expect(m.get("python.pytest")).toBeDefined();
    expect(m.get("python.coverage")?.name).toBe("python.coverage");
    expect(m.get("typescript.tsc")).toBeDefined();
    expect(m.get("typescript.eslint")).toBeDefined();
    expect(m.get("typescript.prettier")).toBeDefined();
    expect(m.get("typescript.vitest")).toBeDefined();
    expect(m.get("go.test")).toBeDefined();
    expect(m.get("go.vet")).toBeDefined();
    expect(m.get("go.golangci")).toBeDefined();
    expect(m.get("golangci")).toBeDefined();
    expect(m.get("python.xenon")).toBeDefined();
    expect(m.get("python.deptry")).toBeDefined();
    expect(m.get("sql.sqlfluff")).toBeDefined();
  });
});

describe("detectAll", () => {
  it("only core capabilities when no languages are detected", () => {
    clearCapabilityCache();
    const caps = detectAll({ version: 1, checks: {}, policies: {} }, "/tmp/matrix-caps-none", {
      python: false,
      typescript: false,
      go: false,
    });
    const names = caps.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("git");
    expect(names).not.toContain("ruff");
    expect(names).not.toContain("tsc");
    expect(names).not.toContain("go");
    expect(caps.find((c) => c.name === "node")?.required).toBe(true);
  });
});
