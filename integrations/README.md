# Host integrations

MatrixCore uses one local stdio MCP server and one portable completion hook. Install the published
exact version in every project with `npm install --save-dev --save-exact @epv44/matrixcore@0.5.1`;
integrations use `npx --no-install` to resolve only that project-local package without downloading
at runtime.

## Codex

Add this repository as a local marketplace, install the `matrix-core` plugin, review and trust its Stop hook, then start a new thread.

## Claude Code

Load `integrations/claude-code/matrix-core` as a plugin. It starts the same MCP server and bundles a native Stop hook.

## Cline

Merge `integrations/cline/cline_mcp_settings.fragment.json` into Cline's MCP settings. Copy the platform-appropriate `TaskComplete` hook into the global Cline hooks directory or the repository's `.clinerules/hooks/` directory and enable hooks. The extensionless file is for macOS/Linux; the PowerShell file is for Windows.

Use the native `TaskComplete` hook for completion enforcement in Cline. MatrixCore intentionally does not ship a Cline `AgentPlugin`: the current public plugin `afterRun` hook cannot block and resume candidate completion, while `TaskComplete` can return Cline's native `cancel` decision.

The hook does nothing in repositories without `quality.yaml`. In configured repositories it requires a current deterministic PASS and, when that project opts into AgentSmith, a current advisory review attempt. MatrixCore uses either its embedded policy or the project's verified, locked GitHub policy bundle; bundles remain declarative and can reference only checks implemented by the installed client. Application tests remain separate project scripts and CI jobs.
