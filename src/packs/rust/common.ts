import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { Observation, RunCtx } from "../../core/types.js";

export function cargoWorkspaces(root: string): string[] {
  const manifests: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "Cargo.toml")) manifests.push(dir);
    for (const entry of entries)
      if (entry.isDirectory() && ![".git", ".quality", "target", "node_modules"].includes(entry.name))
        stack.push(path.join(dir, entry.name));
  }
  const workspaceMembers = new Map<string, string[]>();
  for (const dir of manifests) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    } catch {}
    if (!/^\s*\[workspace\]\s*$/m.test(content)) continue;
    const section = content.split(/^\s*\[workspace\]\s*$/m)[1]?.split(/^\s*\[/m)[0] ?? "";
    const raw = /members\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1] ?? "";
    workspaceMembers.set(
      dir,
      [...raw.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
    );
  }
  const isClaimedMember = (dir: string) =>
    [...workspaceMembers].some(([workspace, members]) => {
      if (dir === workspace || !dir.startsWith(workspace + path.sep)) return false;
      const relative = path.relative(workspace, dir).replaceAll("\\", "/");
      return members.some((member) =>
        member.endsWith("/*") ? relative.startsWith(member.slice(0, -1)) : relative === member.replace(/\/$/, ""),
      );
    });
  return manifests.filter((dir) => !isClaimedMember(dir));
}

export function runCargo(ctx: RunCtx, workspace: string, args: string[]): SpawnSyncReturns<string> {
  const suffix = Buffer.from(path.relative(ctx.root, workspace) || "root")
    .toString("hex")
    .slice(0, 32);
  return spawnSync("cargo", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(ctx.root, ".quality", "cache", "rust", suffix) },
  });
}

export function parseCargoDiagnostics(output: string, root: string): Observation[] {
  const observations: Observation[] = [];
  for (const line of output.split("\n"))
    try {
      const event = JSON.parse(line);
      const diagnostic = event?.message;
      if (event?.reason !== "compiler-message" || !diagnostic) continue;
      const span = diagnostic.spans?.find((s: any) => s.is_primary) ?? diagnostic.spans?.[0];
      observations.push({
        file: span?.file_name ? path.relative(root, path.resolve(root, span.file_name)) : undefined,
        line: span?.line_start,
        col: span?.column_start,
        message: String(diagnostic.message),
        severity: diagnostic.level === "error" ? "error" : diagnostic.level === "warning" ? "warn" : "info",
        ruleId: diagnostic.code?.code,
      });
    } catch {}
  return observations;
}

export function missing(plugin: string, required: boolean, capability: string, metrics: Record<string, null>) {
  return {
    plugin,
    status: required ? ("FAIL" as const) : ("SKIPPED" as const),
    observations: [{ message: `${capability} not found`, severity: required ? ("error" as const) : ("info" as const) }],
    metrics,
    reason: `${capability} missing`,
  };
}
