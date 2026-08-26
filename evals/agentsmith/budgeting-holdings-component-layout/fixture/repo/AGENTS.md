# Project Guidance

This file is the shared instruction entry point for coding agents and human contributors.
Honor `.agentignore` when searching or gathering context.

## Architecture

- Keep the FastAPI modules as the application boundary. Business logic belongs in `finance/services/`.
- Keep external integration logic in `finance/plaid_client/` and persistence in `finance/storage/`.
- Dependencies point downward: boundaries to services, services to clients and storage, clients and storage to models and external systems.
- Storage modules must not import service or API modules. Avoid circular dependencies.
- Read `docs/engineering/architecture.md` before changing module boundaries or database structure.

## Python and SQL

- Put imports at module scope. Use `importlib` only when dynamic loading is the behavior being implemented or tested.
- Do not add blanket lint, type, formatter, coverage, security, or SQL suppressions.
- A targeted suppression requires a matching entry in `quality-exceptions.toml` and must be limited to one rule and one symbol.
- Keep functions focused, use built-in collection types, and type public function parameters and return values.
- Use parameterized SQL. Format embedded SQL so SQLFluff can inspect it without directives.
- Keep direct database execution under `finance/storage/`; boundaries, services, and external clients call repository functions.
- Read `docs/engineering/python.md` for error, logging, dependency, and persistence conventions.

## Frontend

- Reuse the shared UI components and established visual patterns before adding local variants.
- Format only frontend files touched by the current task; do not create unrelated formatting churn.
- Read `docs/engineering/frontend.md` before changing frontend layout, interaction, or styling.

## Testing and verification

- Use pytest for Python tests and keep external-service tests marked as integration tests.
- Verify observable behavior and add regression coverage for changed behavior.
- Run `npm run quality:policy`, `bash scripts/test.sh deterministic`, and the relevant frontend checks before completion.
- Run the project MatrixCore changed and completion gates after code changes.
- Read `docs/engineering/testing.md` for the complete test expectations.

## Safety

- Never log or commit credentials, access tokens, API keys, or raw secret-bearing payloads.
- Preserve unrelated working-tree changes.
- Do not perform destructive data or Git operations without explicit authorization.
