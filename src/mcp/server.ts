#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENGINE_VERSION } from "../core/meta.js";
import { executeQualityTool, type QualityToolName } from "./tools.js";
import { cleanupMcpRuntimeRecords } from "../core/runtime.js";
import type { Readable, Writable } from "node:stream";
import { isMainModule } from "../core/process.js";

export function result(value: unknown) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const markdown =
    value && typeof value === "object" && "reviewMarkdown" in value && typeof value.reviewMarkdown === "string"
      ? value.reviewMarkdown
      : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: markdown }], structuredContent };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

async function call(name: QualityToolName, input: Record<string, unknown>, signal?: AbortSignal) {
  try {
    return result(await executeQualityTool(name, input, signal));
  } catch (error) {
    return failure(error);
  }
}

export function createMatrixCoreMcpServer() {
  const server = new McpServer({ name: "matrix-core", version: ENGINE_VERSION });
  const root = z.string().optional().describe("Workspace root; defaults to host workspace metadata or process cwd");
  server.registerTool(
    "quality_run",
    {
      description:
        "Run centrally owned deterministic checks, an explicit review, or the completion workflow. Completion includes advisory AgentSmith when the project enables it.",
      inputSchema: {
        root,
        mode: z.enum(["changed", "full", "review", "completion"]).default("full"),
        fast: z.boolean().optional(),
        base: z.string().optional(),
      },
    },
    async (input, extra) => call("quality_run", input, extra.signal),
  );
  server.registerTool(
    "quality_status",
    {
      description: "Read the current versioned deterministic gate and advisory review without running checks.",
      inputSchema: { root },
    },
    async (input, extra) => call("quality_status", input, extra.signal),
  );
  server.registerTool(
    "graph_status",
    {
      description: "Ensure the repository graph is ready and return its snapshot identity.",
      inputSchema: { root },
    },
    async (input, extra) => call("graph_status", input, extra.signal),
  );
  server.registerTool(
    "quality_fix",
    {
      description:
        "Prepare a version-bound repair task. This never invokes Ollama or edits code; the active host model applies the returned task.",
      inputSchema: {
        root,
        review_version: z.string(),
        finding_ids: z.array(z.string()).min(1),
      },
    },
    async (input, extra) => call("quality_fix", input, extra.signal),
  );
  return server;
}

export async function startMatrixCoreMcpServer(options?: {
  stdin?: Readable;
  stdout?: Writable;
  installSignalHandlers?: boolean;
}) {
  const server = createMatrixCoreMcpServer();
  const stdin = options?.stdin ?? process.stdin;
  const stdout = options?.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let closing: Promise<void> | null = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      stdin.off("end", onInputClosed);
      stdin.off("close", onInputClosed);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        await server.close();
      } finally {
        cleanupMcpRuntimeRecords();
      }
    })();
    return closing;
  };
  const onInputClosed = () => void close();
  const onSignal = () => void close();
  stdin.once("end", onInputClosed);
  stdin.once("close", onInputClosed);
  if (options?.installSignalHandlers !== false) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  await server.connect(transport);
  return { server, transport, close };
}

async function main() {
  await startMatrixCoreMcpServer();
}

if (isMainModule(import.meta.url))
  main().catch((error) => {
    console.error(`MatrixCore MCP server failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
