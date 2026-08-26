# Python and Persistence Conventions

## Imports and dependencies

Imports belong at module scope and are grouped as standard library, third-party packages, then local modules. Runtime packages must be directly declared in `requirements.txt`; quality-only packages belong in `requirements-quality.txt`. Dynamic loading is reserved for behavior that is intentionally dynamic, not as a circular-import workaround.

## Types and structure

Use built-in generic types such as `list[str]` and `dict[str, int]`, union syntax with `|`, descriptive names, and focused functions. Avoid abstractions unrelated to the requested behavior.

## Errors and logging

Raise exceptions for failures rather than returning magic values. Catch only exceptions that can be handled at that layer. Durable workers may catch unexpected exceptions to record job failure and continue processing; application boundaries may catch them to sanitize user-facing output. Preserve tracebacks with `logger.exception` when diagnosing unexpected failures.

## SQL

All external values use bound parameters. Dynamic clauses must be selected from explicit internal allowlists. Embedded SQL is formatted and linted directly; blanket SQLFluff or `noqa` directives are prohibited. Repository functions own transactions and cleanup behavior explicitly.

## Suppressions

Blanket lint, type, formatting, coverage, SQL, and security suppressions are prohibited. A genuinely necessary targeted exception must identify one rule, one file, one symbol, and a rationale in `quality-exceptions.toml`. The policy checker must pass before the exception is accepted.
