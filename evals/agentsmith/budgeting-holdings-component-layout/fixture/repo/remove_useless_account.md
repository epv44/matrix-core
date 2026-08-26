# Completed: remove `sync_accounts`

Status: Implemented and validated on 2026-08-17. This file is retained as a
historical implementation record.

## Historical findings

- `sync_accounts` is referenced in exactly 3 places: the import + call in `commands.py` and its definition in `sync.py`.
- No tests reference `sync_accounts` — nothing to remove there.
- `usaa_response.json` was never created (prod sync failed before reaching it) — nothing to delete.
- Only `sync.py`'s copy of `AccountsGetRequest` dies; `auth.py` keeps its own for `health_check_token`.
- The `Account` dataclass and `upsert_account()` are not references to `sync_accounts` — they become dead code but are out of scope.

## Completed changes

### 1. `finance/plaid_client/sync.py`

- Delete the `sync_accounts` function entirely (the file-write to `usaa_response.json` + the commented-out DB block).
- Delete `_nested_get` (only used inside `sync_accounts`).
- Remove now-unused imports: `AccountsGetRequest`, `json`, `ApiClient`, `Account`, and `upsert_account` from the repository import list.

### 2. Application boundaries

- Removed the obsolete CLI entrypoint and its account-sync call.
- The web/API sync path remains the supported application boundary.

### 3. Tests

- No changes needed (verified zero references).

### 4. Validation

- Deterministic backend tests and project quality checks pass.

## Historical out of scope

- `Account` dataclass + `upsert_account()` become dead code.
- Checking-vs-saving segmentation is a separate change: parse the `accounts` array from the `transactions_sync` response.
