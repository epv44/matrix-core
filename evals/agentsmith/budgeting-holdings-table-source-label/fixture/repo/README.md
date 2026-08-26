# Personal Finance Dashboard

Local-first household finance aggregator powered by Plaid. The React app uses local email/password sign-in, one shared household budget, and secure cookie sessions. Each member also has a short username used throughout the household UI. Financial data remains split between sandbox and production while identities live in a small shared local database.

Aggregate transactions from different providers. Categorize spending. Track income. Export to Excel. Every mutation auditable. Sandbox and production strictly isolated.

## Quick Start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp config.env.example .env
# Edit .env with Plaid credentials
nvm use
./run.sh
```

The web stack requires Node.js 26. From the repository root, run `nvm use`
before `./run.sh`; the script refuses unsupported Node releases so local and CI
environments use the same Node major. Node.js 26 is a Current release and is
scheduled to enter LTS in October 2026.

`./run.sh` installs the pinned repository-local PM2 runtime when needed, then
keeps the API, webhook receiver, and frontend attached to the foreground with
named `API`, `HOOK`, and `WEB` log prefixes. When `WEBHOOK_URL` is an ngrok URL
ending in `/webhook`, it also supervises a named `NGROK` process that exposes
only port 9000. If the configured endpoint is already provided by the local
household ngrok service, development reuses that tunnel instead of starting a
duplicate. A non-ngrok HTTPS URL is treated as externally managed, and an
invalid URL stops startup. One Ctrl+C asks every service owned by that run to
shut down gracefully and returns the shell prompt; a reused household tunnel
remains online. PM2 uses only the ignored `.pm2/` directory in this repository,
not shared global state. A service that crashes is restarted after one second,
up to five consecutive unstable restarts, after which PM2 leaves it stopped.
Uvicorn and Next continue to own development hot reload; PM2 file watching is
disabled.

`./run.sh --lan` builds the frontend and runs the same services in production
mode on loopback with a single TLS entry point on the local network. It disables
framework reloaders and enables Secure session cookies for the LAN HTTPS entry
point described below.

## Main actions

The web application is the supported application boundary. Use the sidebar to
open Dashboard, History, Financial Tools, Link / Sync, or Settings. Sync,
backfill, diagnostics, exports, account linking, household administration, and
password changes are available through the authenticated web UI.

### Backfill

Plaid `/transactions/sync` cursors are forward-only — they cannot be rewound, so a plain sync can't reach older data once the cursor has advanced. Backfill re-pulls history for one or all institutions back to a target date:

- Resets the stored cursor (no transaction deletion, unlike `--replace`) and re-runs sync; transactions on/after the target date are stored via idempotent upsert and the cursor lands at the head.
- `--since` is required and capped at 730 days (24 months) back — Plaid's Transactions availability ceiling — and future dates are rejected. Institutions may provide less.
- Preview the reachable depth without writing with `[Preview Backfill]` in the Link / Sync page.
- Every run is recorded in `sync_history` with a `backfill` flag.

### History depth, webhooks & re-link

Transaction history depth is fixed at **link time** by `transactions.days_requested` in the link token (default 90 days, max 730). `/transactions/sync` cannot reach beyond that window, so existing items linked without a window can only be extended by deleting and re-linking:

- **New links** request up to 24 months of history by default; the Link/Sync UI lets you pick the exact "get history back to" date. If that window exceeds 30 days, a modal warns that backfilling takes minutes.
- **Webhook (security-first)**: the main API (port 8000) is **never exposed**. A standalone receiver (`finance/webhook_receiver.py`, port **9000**) is the only public endpoint via `ngrok http 9000`; set `WEBHOOK_URL=https://<id>.ngrok-free.app/webhook`. It verifies Plaid's **signed `Plaid-Verification` JWT** (ES256 key from `/webhook_verification_key/get`, `iat` ≤ 5 min, body SHA-256) before forwarding to localhost:8000, which re-verifies and queues an idempotent sync on `SYNC_UPDATES_AVAILABLE`. Unverified requests get `401`; the tunnel exposes nothing else.
- **Re-link for More History**: the button creates a replacement Link session without touching the current Item. After the replacement authenticates, the backend stages its token, removes the old Item, replaces that institution's transaction/audit rows, and starts a fresh sync using the selected history date. Interrupted destructive steps remain recoverable from the persisted re-link session.

## Web Stack — React + FastAPI

Architecture:
```
React Next.js (3000) -> FastAPI (8000) -> services/ -> categorization / plaid_client / storage
                    sidebar Link flow via react-plaid-link
```

The web UI routes user actions to the shared backend services:
```
[React Button] ---> FastAPI router ---> services/ ---> Plaid / storage
```

### Run API

```bash
source .venv/bin/activate
uvicorn finance.api.main:app --reload --port 8000
# health: http://localhost:8000/health
# docs: http://localhost:8000/docs
```

### Run Frontend

The standalone receiver is started automatically by `./run.sh`. Set
`WEBHOOK_URL=https://<assigned-domain>.ngrok-free.dev/webhook` to have the same
command start the authenticated ngrok CLI and keep the tunnel attached to the
foreground stack. When the same endpoint is already running locally as the
household LaunchAgent, the command reuses it and starts only the receiver. If
the URL is absent, public webhooks are disabled. Only port 9000 is tunneled;
never expose ports 8000 or 3000. Do not use ngrok pooling to work around an
endpoint conflict; the app needs one authoritative tunnel. For an always-on
deployment, define the endpoint in ngrok's configuration and run ngrok as a
macOS service instead of tying it to this development command.

```bash
cd frontend
npm install
npm run dev
# http://localhost:3000
# API is same-origin through the Next.js /api rewrite
```

The first browser visit creates the household administrator with a household name, username, email, and password. Administrators can add member logins and reconcile likely joint-account duplicates in Settings. Members sign in with email and password; usernames label people in the shared household. Reports are combined by default and can be filtered by owner. Plaid authorization connects financial accounts but does not replace Budget App login.

### LAN-only access

Household browser traffic and public Plaid webhooks intentionally use separate
paths:

```text
household device -> LAN HTTPS -> LAN-TLS proxy :3443 -> Next.js :3000 -> FastAPI :8000
Plaid -> public ngrok HTTPS -> receiver :9000 -> verified internal API request :8000
```

Only the TLS proxy binds a LAN address; API, Next.js, and the receiver stay on
loopback. There is no router port-forward and nothing is reachable from the
internet. Set up the Mac once:

```bash
mkcert -install
mkdir -p certs && cd certs && mkcert -cert-file lan.pem -key-file lan-key.pem "MacBook-Pro-2.local" 192.168.0.51 localhost 127.0.0.1 ::1
cd ..
./scripts/install-lan-launch-agent.sh
```

The installer starts the LAN stack at macOS login. When `WEBHOOK_URL` uses a
reserved ngrok domain, it also installs a separate LaunchAgent that tunnels only
receiver port 9000. The Mac must remain logged in, awake, and on the network.

Use `https://<host>:3443` from household devices, where `<host>` is whatever the
certificate covers. `BUDGET_LAN_HOST` (default: `<MacName>.local`) controls the
printed URL and the Plaid redirect URI. Android does not resolve `.local` names
reliably, so for mixed household devices reserve a static DHCP lease for the
Mac and set `BUDGET_LAN_HOST` to the LAN IP before installing the agent:

```bash
BUDGET_LAN_HOST=192.168.0.51 ./scripts/install-lan-launch-agent.sh
```

No installation is required on household devices. Because the certificate is
self-signed (mkcert), each browser clicks through the one-time "not private"
warning for `https://<host>:3443`; the browser remembers the exception for that
host, and the Plaid OAuth callback to the same origin also works. Register
`https://<BUDGET_LAN_HOST>:3443/oauth/callback` as an allowed redirect URI in
Plaid Dashboard -> Team Settings -> API; OAuth banks resume through that
callback after authorization. When the LAN IP changes, regenerate the
certificate for the new host/IP and re-register the redirect URI.

Anyone on the same LAN can reach the HTTPS login page; traffic is encrypted and
the app requires a household session, but the certificate is self-signed, so
only click through the warning for the hostname you control. To stop the LAN
LaunchAgents while keeping their plist files available for restart, run
`./scripts/stop-lan-launch-agents.sh`. Stop them before moving or deleting the
repository.

In Settings -> Account Settings, an administrator enters the second member's
email and creates a single-use invitation link. The link expires after 48 hours
and is shown only once; send it directly to the invited member. The member opens
the link and chooses their own username and 12-character-or-longer
password. They can then view the combined budget and link accounts. New
connections are assigned to the signed-in member. If Plaid asks for a phone
number, that person enters their own number inside Plaid; Budget App does not
store it. Unlink and ownership management remain administrator-only.

Use a normal Safari or browser tab for mobile Plaid Link. Embedded application
webviews require a separately registered Plaid OAuth redirect flow.

### Credential stores

Plaid token access goes through `finance/security/token_store.py`. macOS uses
Keychain by default. Linux uses an AES-256-GCM vault with a separate 0600 master
key:

```bash
umask 077
openssl rand -base64 32 > /etc/budget-app/token-store.key
chmod 600 /etc/budget-app/token-store.key
TOKEN_STORE_BACKEND=encrypted-file
TOKEN_STORE_PATH=/var/lib/budget-app/plaid-tokens.enc
TOKEN_STORE_KEY_FILE=/etc/budget-app/token-store.key
```

Set those three values in the protected service environment. The application
fails closed for unknown backends, missing keys, or permissive key/vault modes.
Credential-store migration is not automated; re-link institutions on the target
machine rather than copying access tokens through the application.

The encrypted-file backend supports Linux deployments. To migrate, copy the
three SQLite databases only while the Mac stack is stopped and run only one
writer. Move the reserved ngrok domain to the target machine before starting
sync. If the public webhook URL changes, update `WEBHOOK_URL` in the protected
environment and re-link each institution from Link / Sync after the new
receiver is live.

Administrators change member passwords from Settings → Account Settings.

The repository intentionally has two npm lockfiles: the root package installs
the local MatrixCore quality tooling, while `frontend/package-lock.json` owns
the Next.js application. `turbopack.root` is pinned to `frontend`, so the root
lockfile cannot change Next.js module identities. If generated state becomes
stale, run `npm run dev:clean`; use `npm run dev:webpack` as the maintained
diagnostic fallback.

### Dashboard (Monthly Spreadsheet View)

Purpose: default landing page to show monthly spending vs. income by category.
Features: month dropdown, same 10 category columns as Excel `SHEET_CATEGORIES` via `_col_for_category = 1+idx*3`, rows merchant+amount, totals `=SUM()`, summary stats (Uncategorized count, Net cash flow) at top, one-click Export.

**Tabs:** the Dashboard has Yearly Summary (default), Monthly breakdown, and Investment Tracking. Yearly Summary shows an Annual Summary (Expense / Budget / Income / Net Income per month, using the Monthly Budget setting) and an Expenses-by-Category matrix (Jan–Dec + Total/Average/Percentage + Category Cap), reusing the same resolver and sheet categories as the monthly view. Set the budget in Settings → Budget and per-category monthly caps in Settings → Categories; caps are stored per category id in the dedicated `category_caps` table.

**Clickable spreadsheet:** each merchant cell is clickable button — click opens detail dialog with tooltip-like view: charge date, institution, categorization trace (order: category_rules DB -> MERCHANT_CATEGORY_OVERRIDES -> stored -> PFC -> legacy -> MISC.), and Reclassify button (triggers `category_changes` audit + optional `category_rule` remember + bulk similar scope).

**Rule matching:** `category_rules` have an explicit `match_type` (`MERCHANT`, `DESCRIPTION`, `BOTH`, `PREFIX`, `EXACT`, `REGEX`) and resolve by highest `priority` first; on a priority tie the **longest matching pattern wins**. A specific rule like `AMAZON PRIME VIDEO -> MISC.` beats a broad `Amazon -> Home Goods`. Seeded specific overrides (`SPECIFIC_CATEGORY_OVERRIDES`, priority 100): `AMAZON PRIME`, `AMAZON PRIME VIDEO`, `AMAZON KINDLE`, `AMAZON WEB SERVICES` → `MISC.`; everything else matching `Amazon` stays `Home Goods`.

**Single resolver, nothing stored:** `resolve_category_for_transaction` is the only classifier — **manual override (`manual_category_id`) → category rules → PFC → legacy → MISC.** — and `resolve_transaction_type` does the same for INCOME/EXPENSE/TRANSFER (`type_override → type_rules → classify`). The resolved category and transaction type are returned to the UI and exports but are not persisted as derived columns; only user intent is persisted (`manual_category_id`, `type_override`), audited in `category_changes` with a `reason`. A rule change instantly updates every report, and category and transaction type can be edited independently.

### Transaction Browser

Filters: Uncategorized Only toggle, Timeframe (Last month, Last 3 months, Custom), Institution & Account (account_id from transactions, no accounts table), Category, Pending only.
Columns: Date, Description, Merchant, Amount, Account, Institution, Category, Source.
Actions: click merchant -> detail dialog + reclassify. Category and transaction type are independent edits. A category edit sets a **per-transaction manual override** (`manual_category_id`, audited in `category_changes` with reason MANUAL); a type edit sets `type_override`. The optional rule checkbox upserts rules only for the fields changed in that save — one rule per (pattern, match_type), so creating one replaces any older conflicting rule and instantly applies to all matching transactions (past + future).

### Income Breakdown View

Group by: Employer, Source, Account, Merchant/Payee. Uses the resolved transaction type: INCOME/EXPENSE/TRANSFER.

### Navigation

Budget App
 ├── Dashboard (Yearly, Monthly, Investments)
 ├── History (Depository, Investment, Income)
 ├── Financial Tools (Rent vs. Buy, Monte Carlo)
 ├── Link / Sync (link institutions, sync, diagnostics, backfill)
 └── Settings (Goals, accounts, household members)

With `WEBHOOK_URL` configured, linking asks Plaid for up to 24 months of history by default (`transactions.days_requested=730`); the UI date picker can request less. Without a webhook, new Item requests are capped at 30 days. History depth is fixed per Item, so extending an older connection requires replacement re-linking.

### Environment Controls

Top-level toggle sandbox/production. Never mix. Separate DBs `finance_sandbox.db` vs `finance_production.db` via `db_path_for_env()`, separate credential-store labels `plaid_access_token_{env}_{institution}`.

## Frontend

The React app in `frontend/` drives the spreadsheet experience.

## Security

- Plaid Client ID + Secret in `.env` — never committed.
- Access tokens use a configurable secure token store: macOS Keychain or an AES-256-GCM Linux vault with a separate 0600 key. Labels are environment-aware.
- SQLite files are unencrypted and mode 0600. Passwords use Argon2id hashes; opaque session tokens are stored only as hashes and sent in HttpOnly SameSite cookies.
- Each Plaid Item is a distinct connection with a stable connection UUID and UUID-keyed credential. Provider accounts map to canonical household accounts with one or more owners and one authoritative provider source, preventing confirmed joint-account copies from being counted twice.
- Logs sanitized.

### Audit History

`category_changes`: transaction_id, old_category, new_category, timestamp. Every assign via service inserts audit; household attribution can be added to this legacy audit stream separately.

### Sync History

`sync_history`: env, institution_id (name resolved via join), since, replace, backfill, status (ok/error), added/modified/removed counts, error, started_at/finished_at. Written by `sync_institution` on every sync (success and failure). View via `GET /api/sync/history?env=` or the Sync page (sidebar → Sync → Sync History).

## Design Principles

1. User actions initiate links and manual syncs; verified Plaid webhooks enqueue durable background transaction syncs.
2. UI never writes directly to Plaid tables.
3. Spreadsheet view is presentation layer, not stored data — exact mirror of exporter.py _col_for_category layout.
4. Categories user-controlled via categories table + rules.
5. Every mutation auditable.
6. Sandbox and production strictly isolated.
7. React is the only UI layer.
9. Per-entity config lives in dedicated tables keyed by `*_id` (no FK constraints — repository owns cleanup); the generic `settings` table is only for app-wide scalar settings.

## Quality Gate (MatrixCore)

This project runs the MatrixCore quality gate from the project-local `@epv44/matrixcore` package. Agent hosts may provide their own
adapters, while the repository commands and CI workflow remain the harness-independent source of truth.

- MatrixCore is an exact project-local `@epv44/matrixcore` dependency; no sibling MatrixCore checkout or
  machine-specific path is required. Engine checks are selected by this project's `quality.yaml`.
- The v2 central profile enforces Ruff, Ruff Format, mypy, Xenon B/B/A complexity,
  Deptry, SQLFluff for embedded SQLite, frontend TypeScript, and frontend ESLint.
  Project test semantics remain in the separate backend and browser CI jobs.
- Install the exact Python checker versions with
  `pip install -r requirements-quality.txt`; gate state is stored in `.quality/`.
- Setup: the root Git repository tracks both backend and `frontend/`; generated artifacts are ignored
  so the gate fingerprint remains stable. MatrixCore is installed as a project dependency and hosts use its
  `matrixcore-mcp` and `matrixcore-hook` executables.
- Run:
  ```bash
  npm run quality:policy
  npx --no-install matrix-core run --changed --fast
  npm run quality:completion
  # or from any configured agent host: quality_run(mode=completion)
  ```
- Watch live: `tail -f .quality/gate.log`
- `.quality/completion-gate.json` is the canonical full result;
  `.quality/changed-gate.json` contains development feedback and cannot authorize completion.
- General setup and host-integration documentation ship inside `node_modules/@epv44/matrixcore/`.

## Shared agent guidance

`AGENTS.md` contains the durable project rules used by Codex, Cline, and other compatible coding agents. Detailed architecture,
Python, persistence, and testing conventions live under `docs/engineering/`. `.agentignore` is the neutral context-exclusion list;
`.clineignore` is its checked-in Cline adapter and must remain byte-for-byte synchronized.

Blanket lint suppressions and function-local imports are prohibited. Run `npm run quality:policy` to check Ruff import placement,
suppression policy, agent-ignore drift, and machine-specific agent configuration paths. Any targeted exception must be listed in
`quality-exceptions.toml` with its rule, file, symbol, and rationale.

### Backend test profiles

BudgetTool owns its test semantics; MatrixCore only runs the deterministic selection declared in
`quality.yaml`. The same project commands are available locally and in CI:

```bash
npm run test:backend  # deterministic, no external service
npm run test:plaid    # live Plaid sandbox; requires local credentials and network
npm run test:all      # deterministic and live Plaid
```

Automatic push and pull-request CI uses `test:backend`. The manual Plaid workflow uses the identical
`test:plaid` command with sandbox secrets. AgentSmith is enabled for this project and runs during the
configured completion workflow; its findings are advisory and are reported for explicit user selection.
