# Quality Engine

Standalone quality engine + Cline adapter.

- Fact-based plugins (ruff, mypy, pytest owning coverage)
- Policy + explicit baseline regression
- Capabilities: PASS/FAIL/SKIPPED/ERROR with requiredness
- Cline hooks: beforeRun, afterTool, afterRun/run_end (no attempt_completion)

```
npm run build
node dist/core/cli.js doctor
node dist/core/cli.js run
node dist/core/cli.js run --changed --base main
node dist/core/cli.js baseline create --force
quality run --full --json
```

Cline plugin via `cline.plugins` field -> dist/adapters/cline/index.js
Tool: `quality_run` mode=changed|full
Hooks: afterRun fail_closed enforcement.

Monorepo config resolution: flag > cwd > parents > .git root > default embedded, nearest wins.
```

