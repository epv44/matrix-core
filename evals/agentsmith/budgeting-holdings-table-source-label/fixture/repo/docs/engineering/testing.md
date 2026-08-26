# Testing

Use pytest for Python tests. Unit tests do not call external services; Plaid sandbox tests are marked `integration`. Shared setup belongs in fixtures, and `tmp_path` is used for temporary files and databases.

Tests verify observable return values, API responses, generated documents, persistence outcomes, and failure behavior. They call production logic instead of duplicating it. Parameterization is preferred for repeated cases, while multiple assertions are acceptable when they describe one coherent behavior.

Import and startup tests use module-scope imports. If module reloading is itself under test, use an explicit `importlib` helper rather than an import statement inside a test.

Required verification for a completed change:

1. `npm run quality:policy`
2. `bash scripts/test.sh deterministic`
3. `npm --prefix frontend run format:check -- <changed-files>` for touched frontend files
4. `npm --prefix frontend run check` for frontend or shared-contract changes
5. Relevant browser tests for user-facing flows
6. MatrixCore changed and completion gates

Live Plaid tests are run only when sandbox credentials and network access are intentionally available.
