import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ToolProbeResult {
  binary: string;
  found: boolean;
  version: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
  stdout: string;
  stderr: string;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

export function childProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = pathKey(env);
  const runtimeDirectory = path.dirname(process.execPath);
  const entries = (env[key] ?? "").split(path.delimiter).filter(Boolean);
  env[key] = [
    runtimeDirectory,
    ...entries.filter((entry) => path.resolve(entry) !== path.resolve(runtimeDirectory)),
  ].join(path.delimiter);
  return env;
}

export function probeToolVersion(binary: string, timeout = 5000): ToolProbeResult {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout,
    env: childProcessEnv(),
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const error = result.error as NodeJS.ErrnoException | undefined;
  const combined = `${stdout}${stderr}`;
  const version = result.status === 0 ? (combined.match(/\d+(?:\.\d+){1,2}/)?.[0] ?? null) : null;
  return {
    binary,
    found: !error && result.status === 0 && version !== null,
    version,
    exitCode: result.status,
    signal: result.signal,
    timedOut: error?.code === "ETIMEDOUT",
    errorCode: error?.code,
    errorMessage: error?.message,
    stdout,
    stderr,
  };
}

export function describeToolProbe(tool: string, probe: ToolProbeResult): string {
  if (probe.timedOut) return `${tool} version probe timed out for ${probe.binary}`;
  if (probe.errorMessage)
    return `${tool} could not execute ${probe.binary}: ${probe.errorCode ? `${probe.errorCode}: ` : ""}${probe.errorMessage}`;
  if (probe.exitCode !== 0)
    return `${tool} version probe exited ${probe.exitCode ?? "without a status"} for ${probe.binary}${probe.stderr.trim() ? `: ${probe.stderr.trim()}` : ""}`;
  return `${tool} returned an unrecognized version from ${probe.binary}`;
}
