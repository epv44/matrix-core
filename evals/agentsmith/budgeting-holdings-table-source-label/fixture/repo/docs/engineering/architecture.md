# Architecture

## Layers and dependency direction

The application boundary is FastAPI under `finance/api/`. It calls application services under `finance/services/`. Services may use Plaid and other external clients under `finance/plaid_client/`, persistence under `finance/storage/`, categorization, security helpers, and models. Storage and clients must not import services or boundaries.

Expected failures use the shared `AppError` hierarchy. The API boundary translates expected failures into HTTP responses. Unexpected failures retain their traceback and are logged at a boundary or durable worker boundary.

## Configuration and logging

Configuration is loaded at startup and resolved per environment. Sandbox and production use separate SQLite files. Modules create loggers with `logging.getLogger(__name__)`; logger instances are not passed through constructors or stored on data models.

## SQLite conventions

Schema migrations live in `finance/storage/schema.py`. Every schema change bumps `SCHEMA_VERSION`, adds a migration step, and updates the fresh-schema path so new and migrated databases converge.

All direct database execution belongs under `finance/storage/`. Domain repository modules expose connection-first functions and return dataclasses or plain projections rather than `sqlite3.Row`. API, service, and external-client modules retain validation and orchestration but must not call `execute`, `executemany`, or `executescript` directly. Schema operations and connection PRAGMAs remain in their dedicated storage modules.

Application-owned entities use integer surrogate IDs where practical. Provider-owned resources retain stable provider identifiers such as Plaid account, security, and transaction IDs. Relationships are maintained by repository operations rather than SQLite foreign-key cascades. Entity-scoped configuration belongs in dedicated tables; the generic settings table is limited to application-wide scalar settings.

## External operations

Retry only transient external failures, with bounded attempts, timeout, exponential backoff, and jitter. Validation, authentication, and programming failures are not retried. Retry behavior belongs in the external client responsible for the operation.

Long-lived Plaid credentials are accessed through the `TokenStore` boundary in
`finance/security/token_store.py`. Integrations and services must not call an
operating-system credential command directly. Backends fail closed: macOS uses
Keychain, while Linux household deployments use the encrypted-file backend with
a separately protected master key.

LAN HTTPS is terminated by the LAN-TLS proxy in `finance/api/lan_proxy.py` and
proxied to loopback Next.js. Next.js proxies same-origin `/api` requests to
loopback FastAPI. Only the proxy binds a LAN address. Public Plaid
traffic is limited to the standalone signed-webhook receiver on port 9000; the
receiver forwards verified payloads to the internal API and must never expose
the main application boundary.
