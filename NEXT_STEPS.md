# MatrixCore — Next Steps

Working roadmap. Status legend: `done` · `pending`.

## Completed

- Host-neutral deterministic gate and advisory AgentSmith review APIs — `done`.
- Metadata-driven Python, TypeScript, Go, and Rust quality packs — `done`.
- Local stdio MCP tools (`quality_run`, `quality_status`, `quality_fix`) — `done`.
- Native completion hooks for Cline TaskComplete and Codex/Claude Code Stop — `done`.
- Active-host fix handoff: AgentSmith reports findings; the user's Cline, Codex, or Claude model applies selected fixes — `done`.
- Opt-in live Ollama maintainer E2E with prerequisite skip behavior and no model downloads — `done`.
- Publish `@epv44/matrixcore@0.5.0` and normalize release installation examples — `done`.
- BudgetingTool nested frontend repository flattened into its parent repository; generated artifacts ignored and README status refreshed — `done`.

## Pending

- Exercise each native hook in a fresh interactive host session after installation; automated tests cover payload translation and shared policy.
- Add future host integrations by reusing the MCP tools and mapping that host's completion event to `matrixcore-hook`.
