import { describe, expect, it } from "vitest";
import { compareCompletionIdentity } from "../src/core/status.js";
import type { CompletionIdentitySnapshot, GateResult } from "../src/core/types.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";

const current: CompletionIdentitySnapshot = {
  workspaceVersion: "current-version",
  workspaceHash: "current-workspaces",
  policyHash: "current-policy",
  toolVersions: { "typescript:.:tsc": "5.9.3" },
  engineVersion: "0.3.1",
  enginePath: "/consumer/node_modules/matrixcore/dist/hooks/runner.js",
  enginePackageRoot: "/consumer/node_modules/matrixcore",
};

function gate(over: Partial<GateResult> = {}): GateResult {
  return {
    schemaVersion: 2,
    version: current.workspaceVersion!,
    mode: "full",
    fast: false,
    baseBranch: "main",
    changedFilesHash: null,
    changedFileCount: 0,
    status: "PASS",
    checks: [],
    failures: [],
    metrics: {},
    timestamp: "2026-01-01T00:00:00Z",
    createdBy: {
      tool: "quality_run",
      adapter: "mcp",
      engineVersion: current.engineVersion!,
      enginePath: "/consumer/node_modules/matrixcore/dist/mcp/server.js",
      enginePackageRoot: current.enginePackageRoot!,
    },
    workspaces: [],
    workspaceHash: current.workspaceHash!,
    policy: { ...resolvePolicy(), policyHash: current.policyHash! },
    toolVersions: current.toolVersions,
    ...over,
  };
}

describe("completion identity diagnostics", () => {
  it("accepts different MCP and hook executables from one engine package", () => {
    expect(compareCompletionIdentity(gate(), current).mismatches).toEqual([]);
  });

  it("names every stale fingerprint dimension exactly", () => {
    const stale = gate({
      version: "old-version",
      workspaceHash: "old-workspaces",
      policy: { ...resolvePolicy(), policyHash: "old-policy" },
      toolVersions: { "typescript:.:tsc": "5.8.0", "typescript:.:eslint": "9.0.0" },
      createdBy: {
        tool: "quality_run",
        adapter: "mcp",
        engineVersion: "0.3.0",
        enginePath: "/other/node_modules/matrixcore/dist/mcp/server.js",
        enginePackageRoot: "/other/node_modules/matrixcore",
      },
    });
    expect(compareCompletionIdentity(stale, current).mismatches).toEqual([
      "workspaceVersion",
      "workspaceHash",
      "policyHash",
      "toolVersion:typescript:.:eslint",
      "toolVersion:typescript:.:tsc",
      "engineVersion",
      "enginePackageRoot",
    ]);
  });
});
