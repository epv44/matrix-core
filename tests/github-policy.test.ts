import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  POLICY_LOCK_FILE,
  githubPolicyStatus,
  resolveCachedGitHubPolicy,
  syncGitHubPolicy,
  type GitHubPolicyManifest,
} from "../src/core/github-policy.js";
import type { GitHubPolicySource } from "../src/core/types.js";
import { getQualityStatus } from "../src/core/status.js";
import { runDoctor } from "../src/core/doctor.js";
import { loadSpecialists } from "../src/agentsmith/registry.js";
import { loadStructuredRules } from "../src/agentsmith/rules.js";
import { runGate } from "../src/core/gate.js";

const commit = "a".repeat(40);
const source: GitHubPolicySource = {
  source: "github",
  repository: "example/policies",
  ref: "stable",
  manifest: "matrixcore/policy.json",
};
const agentFiles = [
  "agents/sub-agents/architecture-reviewer.md",
  "agents/sub-agents/perf-reviewer.md",
  "agents/sub-agents/bug-hunter.md",
  "agents/sub-agents/semantic-reviewer.md",
  "rules/registry.yaml",
];

function digest(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture(overrides: Partial<GitHubPolicyManifest> = {}) {
  const bodies = Object.fromEntries(
    agentFiles.map((relative) => [
      `agentsmith/${relative}`,
      fs.readFileSync(path.join(process.cwd(), "src", "agentsmith", relative)),
    ]),
  );
  const manifest: GitHubPolicyManifest = {
    schemaVersion: 1,
    id: "fixture.default.v1",
    minEngineVersion: "0.5.0",
    checks: [
      {
        id: "typescript.eslint",
        requiredVersion: "9.39.5",
        settings: { profile: "embedded-recommended", maxWarnings: 0 },
      },
    ],
    agentSmith: {
      id: "fixture.agentsmith.v1",
      outputSchemaVersion: 4,
      provider: "ollama",
      models: [
        {
          id: "fixture-small",
          provider: "ollama",
          model: "fixture",
          contextTokens: 8192,
          reviewCapability: "small",
          requestedOutputTokens: 1024,
          safetyReserveTokens: 1000,
          tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
          inference: { temperature: 0, thinking: false, timeoutMs: 120000 },
        },
      ],
      defaultModels: { candidate: "fixture-small", verifier: "fixture-small" },
      routing: { inputContextFraction: 0.7, enableHolistic: true, enablePartitioned: true, enableHybrid: true },
      graph: { defaultHops: 1, maxHops: 2, maxInteractionNeighborsPerSymbol: 8, enableHighRiskTwoHopExpansion: true },
      partitioned: {
        maxParallelUnits: 20,
        maxRulesPerUnit: 8,
        maxUnitsPerChangedSymbol: 6,
        preferSemanticBoundaries: true,
        hunkFallback: true,
      },
      evidence: { maxRequestsPerCandidate: 8, maxParallelResolutions: 20, maxSnippetLines: 160 },
      verification: { enabled: true, publish: "verified-only" },
      concurrency: 1,
      cache: true,
      assetRoot: "agentsmith",
    },
    assets: Object.entries(bodies).map(([assetPath, body]) => ({
      path: assetPath,
      sha256: digest(body),
      size: body.length,
      mediaType: assetPath.endsWith(".yaml") ? ("application/yaml" as const) : ("text/markdown" as const),
    })),
    ...overrides,
  };
  return { manifest, bodies };
}

function fakeGitHub(manifest: GitHubPolicyManifest, bodies: Record<string, Buffer>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }), { status: 200 });
    if (url.endsWith("/matrixcore/policy.json")) return new Response(JSON.stringify(manifest), { status: 200 });
    const marker = `/${commit}/`;
    const relative = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    const body = bodies[relative];
    return body ? new Response(body, { status: 200 }) : new Response("missing", { status: 404 });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

describe("GitHub policy bundles", () => {
  it("fails closed without a lock/cache and never attempts a fetch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-missing-"));
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: missing\npolicy:\n  source: github\n  repository: example/policies\n  ref: stable\n  manifest: matrixcore/policy.json\n",
    );
    expect(getQualityStatus(root)).toMatchObject({
      configured: true,
      completionAllowed: false,
      reason: expect.stringContaining("quality policy sync"),
    });
    expect(runDoctor({ cwd: root })).toMatchObject({ passed: false });
  });

  it("syncs a public ref to an immutable lock and resolves offline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-policy-"));
    const { manifest, bodies } = fixture();
    const remote = fakeGitHub(manifest, bodies);
    const synced = await syncGitHubPolicy({ root, source, fetchImpl: remote.fetchImpl });
    expect(synced.lock.resolvedCommit).toBe(commit);
    expect(synced.policy).toMatchObject({ provider: "github", profileId: "fixture.default.v1" });
    expect(loadSpecialists(synced.policy.agentSmith.assetRoot)).toHaveLength(4);
    expect(loadStructuredRules(synced.policy.agentSmith.assetRoot).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, POLICY_LOCK_FILE))).toBe(true);
    const callsAfterSync = remote.calls.length;
    const offline = resolveCachedGitHubPolicy(root, source);
    expect(offline.policyHash).toBe(synced.policy.policyHash);
    expect(offline.policyHash).not.toBe(synced.lock.policyHash);
    expect(remote.calls).toHaveLength(callsAfterSync);
    expect(githubPolicyStatus(root, source)).toMatchObject({ cached: true, valid: true, networkUsed: false });
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-policy-second-"));
    const second = await syncGitHubPolicy({
      root: secondRoot,
      source,
      fetchImpl: fakeGitHub(manifest, bodies).fetchImpl,
    });
    expect(second.policy.agentSmith.hash).toBe(synced.policy.agentSmith.hash);
  });

  it("runs a deterministic gate from one cached policy snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-gate-"));
    fs.writeFileSync(
      path.join(root, "quality.yaml"),
      "version: 2\nproject: remote-gate\npolicy:\n  source: github\n  repository: example/policies\n  ref: stable\n  manifest: matrixcore/policy.json\nreview:\n  agentsmith: false\n",
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "remote-gate", private: true }));
    fs.writeFileSync(path.join(root, "example.ts"), "export const value: number = 1;\n");
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
    const { manifest, bodies } = fixture();
    const synced = await syncGitHubPolicy({ root, source, fetchImpl: fakeGitHub(manifest, bodies).fetchImpl });
    const gate = await runGate({ cwd: root, mode: "full" });
    expect(gate).toMatchObject({ status: "PASS", policy: { provider: "github" } });
    expect(gate.policy.policyHash).toBe(synced.policy.policyHash);
  }, 30000);

  it("restores the exact locked commit without resolving the movable ref", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-restore-"));
    const { manifest, bodies } = fixture();
    const first = fakeGitHub(manifest, bodies);
    const synced = await syncGitHubPolicy({ root, source, fetchImpl: first.fetchImpl });
    fs.rmSync(path.join(root, ".quality", "policies", synced.lock.policyHash), { recursive: true });
    const restore = fakeGitHub(manifest, bodies);
    const restored = await syncGitHubPolicy({ root, source, locked: true, fetchImpl: restore.fetchImpl });
    expect(restored.lock.resolvedCommit).toBe(commit);
    expect(restore.calls.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  it("replaces a corrupted cache during locked restore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-corrupt-"));
    const { manifest, bodies } = fixture();
    const synced = await syncGitHubPolicy({ root, source, fetchImpl: fakeGitHub(manifest, bodies).fetchImpl });
    fs.writeFileSync(
      path.join(root, ".quality", "policies", synced.lock.policyHash, "agentsmith", agentFiles[0]),
      "corrupted",
    );
    const restored = await syncGitHubPolicy({
      root,
      source,
      locked: true,
      fetchImpl: fakeGitHub(manifest, bodies).fetchImpl,
    });
    expect(restored.cacheHit).toBe(false);
    expect(resolveCachedGitHubPolicy(root, source).policyHash).toBe(restored.policy.policyHash);
  });

  it("rejects unsupported checks before updating the lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-unknown-"));
    const { manifest, bodies } = fixture({
      checks: [{ id: "shell.arbitrary", requiredVersion: "1.0.0", settings: {} }],
    });
    await expect(syncGitHubPolicy({ root, source, fetchImpl: fakeGitHub(manifest, bodies).fetchImpl })).rejects.toThrow(
      /unsupported check/,
    );
    expect(fs.existsSync(path.join(root, POLICY_LOCK_FILE))).toBe(false);
  });

  it("rejects executable and traversal assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-github-unsafe-"));
    const { manifest, bodies } = fixture();
    manifest.assets.push({
      path: "../run.sh",
      sha256: digest("echo bad"),
      size: 8,
      mediaType: "text/plain",
    });
    bodies["../run.sh"] = Buffer.from("echo bad");
    await expect(syncGitHubPolicy({ root, source, fetchImpl: fakeGitHub(manifest, bodies).fetchImpl })).rejects.toThrow(
      /Unsafe|unsupported/,
    );
  });
});
