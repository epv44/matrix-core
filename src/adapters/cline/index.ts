import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

let createToolFallback: any;
let createToolReal: any;
try {
  // @ts-ignore
  const sdk = await import("@cline/sdk");
  createToolReal = sdk.createTool;
} catch {
  createToolReal = null;
}

function findQualityBin(workspaceRoot?: string): string {
  const cands = [
    path.join(workspaceRoot || process.cwd(), "node_modules", ".bin", "quality"),
    path.join(workspaceRoot || process.cwd(), "dist", "core", "cli.js"),
  ];
  for (const b of cands) if (fs.existsSync(b)) return b;
  return "quality";
}

function runQualityCLI(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null; json?: any }> {
  return new Promise((resolve) => {
    const bin = findQualityBin(cwd);
    const isJs = bin.endsWith(".js");
    const cmd = isJs ? process.execPath : bin;
    const cmdArgs = isJs ? [bin, ...args] : args;
    const child = spawn(cmd, cmdArgs, { cwd, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      let json;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ stdout, stderr, code, json });
    });
    child.on("error", (err: any) => resolve({ stdout, stderr: stderr + err.message, code: 2 }));
  });
}

function defineToolFallback(cfg: any) {
  return cfg;
}

const createToolFn = createToolReal || defineToolFallback;

const qualityRunTool = createToolFn({
  name: "quality_run",
  description: "Runs project's quality engine. Use mode=changed during fixes for speed, full before final completion. Calls local quality CLI.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["changed", "full"], description: "changed=fast git diff, full=entire repo" },
      json: { type: "boolean", description: "return JSON" },
      base: { type: "string", description: "base branch for changed mode, default main" },
    },
    required: [],
  },
  execute: async (input: any, context: any) => {
    const mode = input?.mode || "full";
    const useJson = input?.json ?? true;
    const base = input?.base || "main";
    const cwd = context?.workspaceRoot || context?.metadata?.workspaceRoot || process.cwd();
    const args = ["run", `--${mode}`, "--base", base];
    if (useJson) args.push("--json");
    const res = await runQualityCLI(args, cwd);
    if (useJson && res.json) return res.json;
    const combined = res.stdout + (res.stderr ? "\n" + res.stderr : "");
    return { code: res.code, output: combined.slice(0, 20000) };
  },
});

const plugin = {
  name: "quality-engine-adapter",
  manifest: { capabilities: ["tools", "hooks"] },
  setup(api: any, ctx: any) {
    api.registerTool(qualityRunTool);
  },
  hooks: {
    beforeRun: async (context: any) => {
      const root = context?.workspaceRoot || context?.root || process.cwd();
      const res = await runQualityCLI(["doctor", "--json"], root);
      if (res.json && !res.json.passed) {
        if (context?.injectMessage) context.injectMessage(`Quality Doctor warning: some required capabilities missing. ${res.stdout.slice(0, 2000)}`);
      }
    },
    afterTool: async (context: any) => {
      const name = context?.toolName || context?.name || "";
      if (["write_to_file", "replace_in_file", "execute_command"].includes(name)) {
        if (context?.metadata) context.metadata.lastEditTool = name;
      }
    },
    afterRun: async (context: any) => {
      const root = context?.workspaceRoot || context?.root || process.cwd();
      const res = await runQualityCLI(["run", "--full"], root);
      const out = res.stdout + (res.stderr || "");
      if (res.code !== 0) throw new Error(`Quality Gate Failed in afterRun (final gate):\n${out.slice(0, 8000)}\nFix regressions before completion.`);
    },
    tool_call_before: async (context: any) => {},
    tool_call_after: async (context: any) => {},
    run_end: async (context: any) => {
      const root = context?.workspaceRoot || context?.root || process.cwd();
      const res = await runQualityCLI(["run", "--full"], root);
      const out = res.stdout + (res.stderr || "");
      if (res.code !== 0) throw new Error(`Quality Gate Failed at run_end:\n${out.slice(0, 8000)}`);
    },
    before_agent_start: async (context: any) => {},
  },
};

export default plugin;
