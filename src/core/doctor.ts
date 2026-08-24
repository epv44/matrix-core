import { resolveConfig } from "./config-resolver.js";
import { isGitRepo } from "./changed.js";
import { formatDoctorReport } from "./report.js";
import type { DoctorResult, ResolvedConfig, ResolvedPolicy, Capability } from "./types.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { toolVersion } from "./runner.js";
import { traceStatus } from "../agentsmith/trace.js";
import { mcpRuntimeWarnings } from "./runtime.js";
export function runDoctor(opts: { configFlag?: string; cwd?: string; root?: string }): DoctorResult {
  const resolved: ResolvedConfig = resolveConfig({ configFlag: opts.configFlag, cwd: opts.cwd, root: opts.root });
  const configRoot = resolved.configRoot;
  const workspaceSet = resolveWorkspaceSet(configRoot, resolved.config.application);
  let policy: ResolvedPolicy;
  try {
    policy = resolvePolicyForConfig(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      capabilities: [
        {
          name: "policy:github",
          found: false,
          required: true,
          hint: `${message}. Run quality policy sync or quality policy sync --locked`,
        },
      ],
      config: resolved,
      baselineExists: false,
      baselinePath: "",
      gitRepo: isGitRepo(opts.cwd || opts.root || process.cwd()),
      passed: false,
      warnings: [],
    };
  }
  resolved.workspaces = workspaceSet.workspaces;
  resolved.workspaceHash = workspaceSet.workspaceHash;
  resolved.policy = policy;
  const capabilities: Capability[] = workspaceSet.workspaces.flatMap((workspace) => [
    ...policy.checks
      .filter((check) => check.language === workspace.language)
      .map((check) => {
        const binary = workspace.toolEnvironment.binaries[check.tool];
        const version = binary ? toolVersion(binary) : null;
        return {
          name: `${workspace.id}:${check.tool}`,
          found: version === check.requiredVersion,
          version: version ?? undefined,
          path: binary,
          required: true,
          hint: version
            ? `Expected exact central version ${check.requiredVersion}`
            : `Install ${check.tool} ${check.requiredVersion} in the designated workspace environment`,
        };
      }),
    ...workspace.sqlFacets.flatMap((facet) =>
      policy.checks
        .filter((check) => check.language === "sql")
        .map((check) => {
          const binary = facet.toolEnvironment.binaries[check.tool];
          const version = binary ? toolVersion(binary) : null;
          return {
            name: `${facet.id}:${check.tool}`,
            found: version === check.requiredVersion,
            version: version ?? undefined,
            path: binary,
            required: true,
            hint: version
              ? `Expected exact central version ${check.requiredVersion}`
              : `Install ${check.tool} ${check.requiredVersion} in the designated SQL environment`,
          };
        }),
    ),
  ]);
  const gitRepo = isGitRepo(opts.cwd || opts.root || process.cwd());
  const passed = capabilities.filter((c) => c.required && !c.found).length === 0;
  const tracing = traceStatus(configRoot);
  const warnings = [
    ...(tracing.enabled && !tracing.gitIgnored
      ? ["AgentSmith tracing is enabled but .quality/ is not Git-ignored"]
      : []),
    ...mcpRuntimeWarnings(configRoot),
  ];
  return { capabilities, config: resolved, baselineExists: false, baselinePath: "", gitRepo, passed, warnings };
}
export function doctorToJson(result: DoctorResult) {
  return JSON.stringify(
    {
      passed: result.passed,
      gitRepo: result.gitRepo,
      configPath: result.config.configPath,
      configRoot: result.config.configRoot,
      isDefault: result.config.isDefault,
      workspaceHash: result.config.workspaceHash,
      policyHash: result.config.policy?.policyHash,
      workspaces: result.config.workspaces,
      capabilities: result.capabilities,
      warnings: result.warnings ?? [],
    },
    null,
    2,
  );
}
export function doctorToReport(result: DoctorResult): string {
  return formatDoctorReport(result);
}
