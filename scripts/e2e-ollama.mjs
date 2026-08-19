import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requireLive = process.argv.includes("--require");
const model = "qwen3.5:9b-q4_K_M";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function stop(reason) {
  console.log(`[e2e:ollama] ${requireLive ? "FAILED" : "SKIPPED"}: ${reason}`);
  process.exit(requireLive ? 1 : 0);
}
async function preflight() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags");
    if (!response.ok) stop(`Ollama daemon returned HTTP ${response.status}`);
    const body = await response.json();
    const names = (body.models ?? []).map((item) => item.name);
    if (!names.includes(model)) stop(`${model} is not installed; install it explicitly with: ollama pull ${model}`);
  } catch (error) {
    stop(`Ollama daemon is unavailable at 127.0.0.1:11434 (${error.message})`);
  }
}
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}
function runReview(fixture) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "dist", "core", "cli.js"), "review", "--root", fixture, "--base", "main", "--json"],
    { cwd: fixture, encoding: "utf8", timeout: 600000, maxBuffer: 10 * 1024 * 1024 },
  );
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`quality review did not emit JSON: ${result.stdout}\n${result.stderr}`);
  }
  return value;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await preflight();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-ollama-e2e-"));
try {
  fs.writeFileSync(
    path.join(fixture, "quality.yaml"),
    `version: 2\nproject: matrix-ollama-e2e\nreview:\n  agentsmith: true\n`,
  );
  git(fixture, "init", "-b", "main");
  git(fixture, "config", "user.email", "e2e@example.com");
  git(fixture, "config", "user.name", "Matrix E2E");
  fs.writeFileSync(path.join(fixture, "README.md"), "base\n");
  git(fixture, "add", "quality.yaml", "README.md");
  git(fixture, "commit", "-m", "fixture base");
  fs.writeFileSync(path.join(fixture, "defect.txt"), "A changed fixture for semantic review.\n");
  const first = runReview(fixture);
  assert(first.review.agents?.length === 4, "all four AgentSmith reviewers must run");
  assert(
    first.review.agents.every((agent) => agent.status !== "ERROR"),
    `every reviewer must return valid structured output: ${JSON.stringify(first.review.agents)}`,
  );
  assert(first.gate && first.review, "deterministic and AgentSmith sections must be separate");
  assert(fs.existsSync(path.join(fixture, ".quality", "completion-gate.json")), "gate artifact missing");
  assert(fs.existsSync(path.join(fixture, ".quality", "review-result.yaml")), "review artifact missing");
  const second = runReview(fixture);
  assert(second.review.cacheHit === true, "unchanged second review must hit cache");
  fs.appendFileSync(path.join(fixture, "defect.txt"), "invalidate cache\n");
  const third = runReview(fixture);
  assert(third.review.cacheHit !== true, "changed content must invalidate cache");
  console.log("[e2e:ollama] PASS: four live reviewers, artifacts, and cache invalidation verified");
} catch (error) {
  console.error(`[e2e:ollama] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
