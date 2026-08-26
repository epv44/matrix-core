# Webhook-Driven History Backfill for Plaid Transactions (> 30 days)

> Status: Completed and archived on 2026-08-17. This file records historical
> design rationale; current operation is documented in `README.md`.

Source: an earlier implementation session (2026-08-05). The plan re-linked
existing accounts with `days_requested`, exposed a webhook receiver so Plaid's
background historical pull lands in the database, and verified incoming
webhooks on the free ngrok plan.

## 1. Problem

All three institutions (USAA, Chase, Bilt) stop returning transactions at roughly **May 2-8, 2026** (~90-95 days before today), even when a backfill to 2026-01-01 is requested. The goal is history back to a user-chosen date (e.g., 1 Jan 2026), which is **greater than the initial 30-day pull** Plaid delivers at link time.

## 2. Root cause (confirmed against Plaid docs)

- `/transactions/sync` accepts **only `access_token` + `cursor`** — no date filters. History depth is frozen at **link time** by `transactions.days_requested` on `/link/token/create`.
- `days_requested` **defaults to 90 days** if omitted (max 730). Existing items were linked before `days_requested` was in the code, so their window is capped at the 90-day default. Plaid cannot retroactively extend an existing item.
- Backfill cannot help already-created items → **existing accounts must be deleted (`/item/remove`) and re-linked with `days_requested=730`** (or `days_requested=N` matching the chosen date). Even then, individual banks cap what they expose; re-linking is the experiment that proves each bank's limit.
- Plaid processes a link in two phases:
  - **Initial Pull:** most recent **30 days** downloaded within seconds.
  - **Historical Pull:** the remaining 90-730 days downloaded in the background, taking 30 seconds to several minutes depending on the bank.
- Calling `/transactions/sync` immediately after link completion sees only ~30 days and wrongly concludes the bank provided nothing more. The correct mechanism is a webhook.

## 3. Plaid webhook contract (from `plaid.com/docs/transactions/webhooks/`)

- Pass your webhook endpoint URL via the **`webhook`** parameter to `/link/token/create`.
- After `/transactions/sync` is called for the first time on an item, **`SYNC_UPDATES_AVAILABLE`** webhooks are sent whenever any change happens to the item's transactions. Fetch changes with `/transactions/sync` using the cursor from the last sync.
- **`initial_update_complete: true`** when at least **30 days** of history is available with an update; **`historical_update_complete: true`** when the full history (up to 24 months) is available.
- Plaid POSTs raw JSON from these IPs: `52.21.26.131`, `52.21.47.157`, `52.41.247.19`, `52.88.82.239` (subject to change — do not rely on IP allowlisting).
- Sandbox tooling: `user_transactions_dynamic` + `/transactions/refresh` fire webhooks; `/sandbox/item/fire_webhook` sends a test webhook.

## 4. UX flow

User picks a "Get history back to:" date (month/day/year picker, min = 730 days ago, max = today, default 730 days ago). `N = days between chosen date and today`.

- **`N <= 30`** → no modal, open Plaid Link directly.
- **`N > 30` and webhook enabled** → modal: *"You requested ~N days of history. Backfilling this much data can take several minutes."* — **Continue / Cancel**. Continue → open Plaid Link → initial sync → webhook (`historical_update_complete`) triggers the full backfill in the background.
- **`N > 30` and webhook NOT enabled** → modal: *"You requested ~N days of history. Webhooks are not enabled, so only the most recent 30 days can be synced."* — **Continue / Cancel**. Continue → 30-day initial pull only.
- Modal is an in-page dialog (title, message, Continue/Cancel), not `window.confirm`. `N` computed client-side: `Math.ceil((today - chosen) / 86400000)`.
- Frontend learns webhook availability via new `GET /api/webhook/status` → `{ enabled: boolean, url: string | null }`.
- After link completion, UI shows "History syncing in background — will update when Plaid finishes."

No polling loops anywhere; the webhook is the sole mechanism.

## 5. Implementation

### 5.1 Backend

1. **`WEBHOOK_URL` config** — read in `config/settings.py` from env; add to `config.env.example` / `.env` with ngrok instructions (`ngrok http 9000` → `WEBHOOK_URL=https://<id>.ngrok-free.app/webhook`; free-plan subdomain changes each run).
2. **Link token** (`finance/plaid_client/link.py`, `finance/api/routers/institutions.py` `create_link_token`) — include `webhook=WEBHOOK_URL` when configured; log env, institution, `days_requested`, webhook presence. (`days_requested` already sent, default 730.)
3. **`GET /api/webhook/status`** → `{ enabled: bool, url: string | null }` (frontend modal gate).
4. **`POST /api/webhook/transactions`** (`finance/api/routers/webhook.py`, wired into `finance/api/main.py`):
   - Log every receipt: type, code, `item_id`, `initial_update_complete`, `historical_update_complete`.
   - On `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` → resolve `item_id` → institution (stored via `update_institution_item_id`) → trigger `sync_institution` on a background thread (Plaid expects a fast 2xx; sync runs async).
   - Ignore unknown codes; always ack 200 (after verification passes).
5. **Existing accounts → one-time backfill** — `POST /api/institutions/{name}/relink`:
   - Load current `access_token` from Keychain → call Plaid `/item/remove` → delete Keychain token → reset cursor (keep institution row + transactions; idempotent re-upsert preserves existing rows) → new link token (`days_requested=730`) → frontend "Re-link (backfill)" button → exchange + initial sync → webhook completes the rest.
6. **Exchange + relink logging** — log public-token exchange (env, institution, item_id, ok/fail); relink logs removal + new link. Optional durable `link_history` table mirroring `sync_history`.

### 5.2 Webhook verification (free ngrok plan — no IP allowlisting)

ngrok free cannot IP-allowlist and `--basic-auth` breaks Plaid webhooks (Plaid cannot send credentials). Therefore **Plaid webhook JWT verification is the security boundary**:

- Header **`Plaid-Verification`** contains a JWT. `alg` must be **`ES256`**; `kid` identifies the signing key.
- Fetch the key via **`/webhook_verification_key/get`** (returns a JWK: `kty=EC`, `crv=P-256`, `use=sig`, `x`/`y`) — not a public JWKS URL; requires the Plaid client + secret. Cache by `kid`, re-fetch on unknown `kid` (key rotation).
- Claims:
  - **`iat`** — reject webhooks more than **5 minutes** old (replay protection) or with a future timestamp.
  - **`request_body_sha256`** — SHA-256 of the **raw webhook body** (whitespace-sensitive); recompute and compare with `hmac.compare_digest`.
- New **`finance/security/webhook_verify.py`**:
  - `get_verification_key(client, kid)`.
  - `verify_webhook(client, raw_body: bytes, header: str)` → decode header (reject unless `alg == ES256`), verify signature with the `kid` key, check `iat`, constant-time compare body hash.
- Update `POST /api/webhook/transactions` to read the raw `Request`, verify the `Plaid-Verification` header → **401** on missing/invalid, **400** on body-hash mismatch; log every verified receipt and every rejection.
- Dependencies: add **`PyJWT`** + **`cryptography`** to `requirements.txt`.


### 5.3 Architecture — two processes, webhook-only exposure

Exposing the main API (`:8000`) via ngrok is unacceptable: the FastAPI app has no authentication, and tunneling would expose every route (read all financial data, `/api/sync?replace=true` wipes transactions, `/relink` deletes Keychain tokens, `/link/*` burns Plaid quota). Users/login would add new attack surface without fixing exposure. Auth is the wrong tool — the main app simply must never have an inbound public path.

```
Internet --> ngrok --> [Receiver :9000] (ONLY: POST /webhook, verifies Plaid JWT,
                                         forwards raw event to loopback)
                              | localhost (never exposed)
                              v
                     [Main API :8000] loopback-only: transactions, sync, dashboard
```

1. **`finance/webhook_receiver.py`** — standalone minimal FastAPI app on port **9000**, only route `POST /webhook`:
   - Read raw body + `Plaid-Verification` header.
   - Verify JWT (ES256, key via `/webhook_verification_key/get`, `iat` <= 5 min, body SHA-256 match).
   - Forward the **raw bytes + original header** to `http://localhost:8000/api/webhook/transactions` (loopback) and ack 200.
   - Holds no data, reads no DB, runs no syncs; without a valid Plaid signature returns 401. Nothing else on that port.
   - Run: `uvicorn finance.webhook_receiver:app --port 9000`.
2. **Main API (8000)** — stays bound to `127.0.0.1`; `/api/webhook/transactions` **re-verifies** the forwarded header (defense in depth) and triggers the sync. Never tunneled.

Follows Plaid's best practice: keep the receiver as simple as possible — a verified forwarder whose only job is to accept the webhook.

Optional follow-up (defense-in-depth): shared `X-API-Key` header on main `/api/*` routes so even loopback/LAN requests need a key.

### 5.4 Frontend (`frontend/src/components/LinkSyncView.tsx` + `frontend/src/lib/api.ts`)

- "Get history back to:" date picker (min 730 days ago, max today, default 730 days ago).
- On Link click: compute `N`; if `N > 30` show the modal (webhook-enabled vs disabled copy) — Continue/Cancel.
- On success → exchange → initial sync → "History syncing in background — will update when Plaid finishes."
- "Re-link (backfill)" button per existing institution.


## 6. Tests

- `verify_webhook` unit tests: valid signature passes; wrong alg, expired/future `iat`, body-hash mismatch, unknown `kid`, malformed JWT all fail — using a locally generated ES256 key + matching JWK.
- Receiver route test: missing/invalid header → 401; valid → forwards.
- Webhook handler: `SYNC_UPDATES_AVAILABLE` + `historical_update_complete: true` triggers a sync; other codes ignored; 200 ack.
- Link payload contains `webhook` when configured and the correct `days_requested`.
- `/relink`: `/item/remove` + Keychain cleanup + cursor reset (unit, mocked client); re-link upsert preserves existing transactions.
- e2e: date > 30 days → modal shows (webhook-enabled vs disabled copy); Continue/Cancel.
- Sandbox end-to-end: `POST /sandbox/item/fire_webhook` sends a genuinely signed webhook to verify before going live.

## 7. Files touched

- `finance/config/settings.py` + `config.env.example` — `WEBHOOK_URL`
- `finance/plaid_client/link.py` — `webhook=` in `LinkTokenCreateRequest`
- `finance/api/routers/institutions.py` — relink endpoint, link-token logging
- `finance/api/routers/webhook.py` (new) — `/api/webhook/status`, `/api/webhook/transactions`
- `finance/security/webhook_verify.py` (new) — ES256 verification
- `finance/webhook_receiver.py` (new) — standalone receiver on :9000
- `finance/api/main.py` — wire webhook router
- `frontend/src/components/LinkSyncView.tsx` — date picker, modal, re-link button
- `frontend/src/lib/api.ts` — webhook status + relink calls
- `requirements.txt` — `PyJWT`, `cryptography`
- `tests/` — verifier, receiver, webhook handler, relink, e2e
- `README.md` — two-process run instructions + security section (8000 never exposed)

## 8. Decisions locked

- Polling fallback is **dropped** — webhook is the sole mechanism (ngrok + `WEBHOOK_URL`).
- Tunnel points to the **backend** receiver (`:9000`), never the frontend (`:3000`).
- **No** `plaid-policy.yml` IP allowlisting (free ngrok plan); JWT verification is the security boundary.
- **No** user/login system — separate receiver is the correct fix for exposure.
- Webhook disabled → strictly 30-day initial pull only.
