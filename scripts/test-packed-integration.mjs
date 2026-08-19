import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function hook(cwd, payload) {
  const result = run("npx", ["--no-install", "matrixcore-hook", "codex", "stop"], {
    cwd,
    input: `${JSON.stringify(payload)}\n`,
  });
  return JSON.parse(result.stdout);
}

function identity(gate) {
  return {
    version: gate.version,
    workspaceHash: gate.workspaceHash,
    policyHash: gate.policy.policyHash,
    toolVersions: gate.toolVersions,
    checks: gate.checks.map((check) => check.plugin),
    engineVersion: gate.createdBy.engineVersion,
    enginePackageRoot: gate.createdBy.enginePackageRoot,
  };
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "matrix packed integration "));
const packDirectory = path.join(temporary, "package");
const consumer = path.join(temporary, "consumer workspace");
const symlink = path.join(temporary, "consumer-link");
const npmEnvironment = { ...process.env, npm_config_cache: path.join(temporary, "npm-cache") };
fs.mkdirSync(packDirectory);
fs.mkdirSync(consumer);

let client;
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDirectory], {
    cwd: sourceRoot,
    env: npmEnvironment,
  });
  const tarball = fs.readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not create a tarball");
  fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"matrixcore-packed-consumer","private":true}\n');
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", path.join(packDirectory, tarball)],
    { cwd: consumer, env: npmEnvironment },
  );
  fs.writeFileSync(
    path.join(consumer, "quality.yaml"),
    "version: 2\nproject: packed-consumer\nreview:\n  agentsmith: false\n",
  );
  fs.writeFileSync(path.join(consumer, ".gitignore"), ".quality/\nnode_modules/\n");
  fs.writeFileSync(path.join(consumer, "README.md"), "fixture\n");
  run("git", ["init", "-q"], { cwd: consumer });
  run("git", ["config", "user.email", "matrixcore@example.invalid"], { cwd: consumer });
  run("git", ["config", "user.name", "MatrixCore"], { cwd: consumer });
  run("git", ["add", "."], { cwd: consumer });
  run("git", ["commit", "-qm", "fixture"], { cwd: consumer });
  fs.symlinkSync(consumer, symlink, "dir");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "matrixcore-mcp"],
    cwd: consumer,
    env: { ...process.env, MATRIXCORE_OLLAMA_URL: "http://127.0.0.1:1" },
    stderr: "pipe",
  });
  transport.stderr?.pipe(process.stderr);
  client = new Client({ name: "matrixcore-packed-test", version: "1.0.0" });
  await client.connect(transport);

  const completion = await client.callTool({ name: "quality_run", arguments: { root: ".", mode: "completion" } });
  const mcpResult = completion.structuredContent;
  assert.equal(mcpResult.completionAllowed, true);
  assert.equal(mcpResult.gate.status, "PASS");
  assert.equal(mcpResult.gate.createdBy.adapter, "mcp");
  assert.equal(mcpResult.gate.createdBy.engineVersion, engineVersion);
  assert.equal(fs.realpathSync(mcpResult.root ?? consumer), fs.realpathSync(consumer));
  assert.deepEqual(hook(consumer, { cwd: consumer }), {});
  assert.deepEqual(hook(consumer, { cwd: symlink }), {});

  const mcpGate = JSON.parse(fs.readFileSync(path.join(consumer, ".quality", "completion-gate.json"), "utf8"));
  run("npx", ["--no-install", "matrix-core", "completion", "--root", "."], { cwd: consumer });
  const cliGate = JSON.parse(fs.readFileSync(path.join(consumer, ".quality", "completion-gate.json"), "utf8"));
  assert.deepEqual(identity(cliGate), identity(mcpGate));
  assert.deepEqual(hook(consumer, { cwd: consumer }), {});

  const liveStatus = await client.callTool({ name: "quality_status", arguments: { root: symlink } });
  assert.equal(liveStatus.structuredContent.completionAllowed, true);
  assert.equal(liveStatus.structuredContent.root, fs.realpathSync(consumer));

  const staleTools = { ...cliGate, toolVersions: { "fixture:tool": "0.0.1" } };
  fs.writeFileSync(path.join(consumer, ".quality", "completion-gate.json"), JSON.stringify(staleTools));
  const toolStatus = await client.callTool({ name: "quality_status", arguments: { root: consumer } });
  assert.deepEqual(toolStatus.structuredContent.identity.mismatches, ["toolVersion:fixture:tool"]);

  const stalePolicy = {
    ...cliGate,
    policy: { ...cliGate.policy, policyHash: "0".repeat(64) },
  };
  fs.writeFileSync(path.join(consumer, ".quality", "completion-gate.json"), JSON.stringify(stalePolicy));
  const policyStatus = await client.callTool({ name: "quality_status", arguments: { root: consumer } });
  assert.deepEqual(policyStatus.structuredContent.identity.mismatches, ["policyHash"]);

  fs.writeFileSync(
    path.join(consumer, "quality.yaml"),
    "version: 2\nproject: packed-consumer\nreview:\n  agentsmith: true\n",
  );
  const unavailableReview = await client.callTool({
    name: "quality_run",
    arguments: { root: consumer, mode: "completion" },
  });
  assert.equal(unavailableReview.structuredContent.deterministicPassed, true);
  assert.equal(unavailableReview.structuredContent.completionAllowed, false);
  assert.equal(unavailableReview.structuredContent.advisoryReview.status, "provider_error");
  assert.equal(hook(consumer, { cwd: consumer }).decision, "block");

  const currentGate = JSON.parse(fs.readFileSync(path.join(consumer, ".quality", "completion-gate.json"), "utf8"));
  const otherEngine = {
    ...currentGate,
    createdBy: {
      ...currentGate.createdBy,
      engineVersion: "0.0.0-other",
      enginePath: "/other/engine/dist/mcp/server.js",
      enginePackageRoot: "/other/engine",
    },
  };
  fs.writeFileSync(path.join(consumer, ".quality", "completion-gate.json"), JSON.stringify(otherEngine));
  const mismatch = hook(consumer, { cwd: consumer });
  assert.equal(mismatch.decision, "block");
  assert.match(mismatch.reason, /engineVersion/);
  assert.match(mismatch.reason, /enginePackageRoot/);
  assert.match(mismatch.reason, /producer=0\.0\.0-other@\/other\/engine\/dist\/mcp\/server\.js/);
  assert.ok(mismatch.reason.includes(`hook=${engineVersion}@`));

  console.log("Packed MCP/CLI-to-hook integration passed");
} finally {
  if (client) await client.close().catch(() => undefined);
  fs.rmSync(temporary, { recursive: true, force: true });
}
