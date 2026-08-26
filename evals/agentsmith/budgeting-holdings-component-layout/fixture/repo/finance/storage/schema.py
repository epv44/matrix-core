import logging

from finance.categorization.pfc_map import (
    LEGACY_CATEGORY_MAP,
    MERCHANT_CATEGORY_OVERRIDES,
    PFC_CATEGORY_MAP,
    SEED_TYPE_KEYWORDS,
    SPECIFIC_CATEGORY_OVERRIDES,
)
from finance.categorization.processor import SHEET_CATEGORIES
from finance.storage.connection import get_connection

logger = logging.getLogger(__name__)
SCHEMA_VERSION = 27


def initialize_database(db_path: str, *, check_same_thread: bool = True) -> None:
    """Bring one database schema up to date before runtime work begins."""
    conn = get_connection(db_path, check_same_thread=check_same_thread)
    try:
        run_migrations(conn)
    finally:
        conn.close()


def reset_database(conn) -> None:
    """Drop the legacy core tables and recreate the current schema."""
    conn.executescript(
        """
        DROP TABLE IF EXISTS transactions;
        DROP TABLE IF EXISTS institutions;
        DROP TABLE IF EXISTS schema_version;
        DROP TABLE IF EXISTS categories;
        DROP TABLE IF EXISTS category_rules;
        DROP TABLE IF EXISTS category_changes;
        """
    )
    conn.commit()
    run_migrations(conn)


def get_schema_version(conn):
    cursor = conn.execute(
        """
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'schema_version'
        """
    )
    if cursor.fetchone() is None:
        return None
    row = conn.execute("""
                       SELECT version FROM schema_version
                       """).fetchone()
    return row["version"] if row else None


def run_migrations(conn):
    current = get_schema_version(conn)
    if current is None:
        _apply_initial(conn)
        _migrate_v19(conn)
        _migrate_v20(conn)
        _migrate_v21(conn)
        _migrate_v22(conn)
        _migrate_v23(conn)
        _migrate_v24(conn)
        _migrate_v25(conn)
        _migrate_v26(conn)
        _migrate_v27(conn)
        logger.info("Applied initial schema (version %d)", SCHEMA_VERSION)
    elif current < SCHEMA_VERSION:
        _apply_migrations(conn, current)
        logger.info("Migrated schema from %d to %d", current, SCHEMA_VERSION)
    else:
        logger.info("Schema is up to date (version %d)", current)


def _cat_id(conn, name: str):
    row = conn.execute(
        """
        SELECT id FROM categories
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    return row["id"] if row else None


def _seed_default_categories(conn):
    defaults = [
        "Transportation",
        "Restaurants",
        "Groceries",
        "Living Expenses",
        "Travel",
        "Cat Related",
        "MISC.",
        "Baby",
        "Self",
        "Home Goods",
    ]
    for name in defaults:
        conn.execute(
            """
            INSERT OR IGNORE INTO categories (name) VALUES (?)
            """,
            (name,),
        )


def _seed_config(conn):

    names = set(SHEET_CATEGORIES)
    names.update(LEGACY_CATEGORY_MAP.values())
    for entry in PFC_CATEGORY_MAP.values():
        names.add(entry["primary"])
        names.update(entry["detailed_map"].values())
    names.update(MERCHANT_CATEGORY_OVERRIDES.values())
    names.update(SPECIFIC_CATEGORY_OVERRIDES.values())
    _seed_category_names(conn, names)
    _seed_pfc_mappings(conn, PFC_CATEGORY_MAP)
    _seed_legacy_mappings(conn, LEGACY_CATEGORY_MAP)
    _seed_sheet_layout(conn, SHEET_CATEGORIES)
    _seed_category_rules(conn, MERCHANT_CATEGORY_OVERRIDES, priority=0)
    _seed_category_rules(conn, SPECIFIC_CATEGORY_OVERRIDES, priority=100)
    _seed_type_rules(conn, SEED_TYPE_KEYWORDS)


def _seed_category_names(conn, names) -> None:
    for name in names:
        if name:
            conn.execute(
                """
                INSERT OR IGNORE INTO categories (name) VALUES (?)
                """,
                (name,),
            )


def _seed_pfc_mappings(conn, mappings) -> None:
    for primary, entry in mappings.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO taxonomy_mappings (taxonomy, external_key, external_subkey, category_id, priority) VALUES (
                'pfc', ?, NULL, ?, 0
            )
            """,
            (primary, _cat_id(conn, entry["primary"])),
        )
        for d, cat in entry["detailed_map"].items():
            conn.execute(
                """
                INSERT OR IGNORE INTO taxonomy_mappings (taxonomy, external_key, external_subkey, category_id, priority) VALUES (
                    'pfc', ?, ?, ?, 0
                )
                """,
                (primary, d, _cat_id(conn, cat)),
            )


def _seed_legacy_mappings(conn, mappings) -> None:
    for legacy, cat in mappings.items():
        if cat:
            conn.execute(
                """
                INSERT OR IGNORE INTO taxonomy_mappings (taxonomy, external_key, external_subkey, category_id, priority) VALUES (
                    'legacy', ?, NULL, ?, 0
                )
                """,
                (legacy, _cat_id(conn, cat)),
            )


def _seed_sheet_layout(conn, categories) -> None:
    for pos, cat in enumerate(categories, start=1):
        conn.execute(
            """
            INSERT OR IGNORE INTO sheet_layout (position, category_id) VALUES (?, ?)
            """,
            (pos, _cat_id(conn, cat)),
        )


def _seed_category_rules(conn, overrides, *, priority: int) -> None:
    for pattern, cat in overrides.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO category_rules (pattern, match_type, category_id, priority, source, enabled) VALUES (
                ?, 'BOTH', ?, ?, 'seed', 1
            )
            """,
            (pattern, _cat_id(conn, cat), priority),
        )


def _seed_type_rules(conn, rules) -> None:
    for pattern, txn_type, priority in rules:
        conn.execute(
            """
            INSERT OR IGNORE INTO type_rules (pattern, match_type, transaction_type, priority, source, enabled) VALUES (
                ?, 'BOTH', ?, ?, 'seed', 1
            )
            """,
            (pattern, txn_type, priority),
        )


def _apply_initial(conn):
    conn.executescript("""
                       CREATE TABLE schema_version (version INTEGER NOT NULL);
                                                      INSERT INTO schema_version (version) VALUES (18);
                                                      CREATE TABLE institutions (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          name TEXT NOT NULL UNIQUE,
                                                          plaid_item_id TEXT,
                                                          cursor TEXT,
                                                          last_successful_sync TIMESTAMP,
                                                          token_created_at TIMESTAMP,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE transactions (
                                                          plaid_transaction_id TEXT PRIMARY KEY,
                                                          account_id TEXT NOT NULL,
                                                          institution_id INTEGER,
                                                          date DATE NOT NULL,
                                                          amount DECIMAL(12,2) NOT NULL,
                                                          merchant TEXT,
                                                          raw_description TEXT,
                                                          manual_category_id INTEGER,
                                                          manual_category_set_at TIMESTAMP,
                                                          type_override TEXT CHECK(type_override IN ('INCOME','TRANSFER','EXPENSE')),
                                                          is_ignored INTEGER DEFAULT 0,
                                                          pending INTEGER DEFAULT 0,
                                                          currency TEXT DEFAULT 'USD',
                                                          plaid_category TEXT,
                                                          plaid_subcategory TEXT,
                                                          pfc_primary TEXT,
                                                          pfc_detailed TEXT,
                                                          payment_processor TEXT,
                                                          removed INTEGER DEFAULT 0,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE categories (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          name TEXT NOT NULL UNIQUE,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE category_rules (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          pattern TEXT NOT NULL,
                                                          match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                                                          category_id INTEGER NOT NULL,
                                                          priority INTEGER DEFAULT 100,
                                                          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                                                          enabled INTEGER DEFAULT 1,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          UNIQUE(pattern COLLATE NOCASE, match_type)
                                                      );
                                                      CREATE TABLE type_rules (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          pattern TEXT NOT NULL,
                                                          match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                                                          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('INCOME','TRANSFER','EXPENSE')),
                                                          priority INTEGER DEFAULT 100,
                                                          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                                                          enabled INTEGER DEFAULT 1,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          UNIQUE(pattern COLLATE NOCASE, match_type)
                                                      );
                                                      CREATE TABLE taxonomy_mappings (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          taxonomy TEXT NOT NULL CHECK(taxonomy IN ('pfc','legacy')),
                                                          external_key TEXT NOT NULL,
                                                          external_subkey TEXT,
                                                          category_id INTEGER NOT NULL,
                                                          priority INTEGER DEFAULT 0,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          UNIQUE(taxonomy, external_key, external_subkey)
                                                      );
                                                      CREATE TABLE sheet_layout (
                                                          position INTEGER NOT NULL,
                                                          category_id INTEGER NOT NULL,
                                                          UNIQUE(position),
                                                          UNIQUE(category_id)
                                                      );
                                                      CREATE TABLE category_changes (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          transaction_id TEXT NOT NULL,
                                                          from_category_id INTEGER,
                                                          to_category_id INTEGER,
                                                          reason TEXT NOT NULL DEFAULT 'MANUAL' CHECK(reason IN ('MANUAL','RULE','AI','IMPORT')),
                                                          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE sync_history (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          env TEXT NOT NULL,
                                                          institution_id INTEGER,
                                                          since TEXT,
                                                          replace INTEGER DEFAULT 0,
                                                          backfill INTEGER DEFAULT 0,
                                                          status TEXT NOT NULL,
                                                          added INTEGER DEFAULT 0,
                                                          modified INTEGER DEFAULT 0,
                                                          removed INTEGER DEFAULT 0,
                                                          error TEXT,
                                                          started_at TIMESTAMP,
                                                          finished_at TIMESTAMP,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE settings (
                                                          key TEXT PRIMARY KEY,
                                                          value TEXT NOT NULL,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE category_caps (
                                                          category_id INTEGER PRIMARY KEY,
                                                          monthly_cap TEXT NOT NULL,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE relink_sessions (
                                                          id TEXT PRIMARY KEY,
                                                          env TEXT NOT NULL,
                                                          institution_id INTEGER NOT NULL,
                                                          history_date TEXT NOT NULL,
                                                          days_requested INTEGER NOT NULL,
                                                          status TEXT NOT NULL DEFAULT 'pending',
                                                          pending_token_label TEXT,
                                                          new_item_id TEXT,
                                                          error TEXT,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE TABLE webhook_jobs (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          delivery_id TEXT NOT NULL UNIQUE,
                                                          env TEXT NOT NULL,
                                                          item_id TEXT NOT NULL,
                                                          webhook_type TEXT NOT NULL,
                                                          webhook_code TEXT NOT NULL,
                                                          initial_update_complete INTEGER,
                                                          historical_update_complete INTEGER,
                                                          status TEXT NOT NULL DEFAULT 'pending',
                                                          attempts INTEGER NOT NULL DEFAULT 0,
                                                          last_error TEXT,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                                      );
                                                      CREATE INDEX IF NOT EXISTS idx_webhook_jobs_status ON webhook_jobs(status, id);
                                                      CREATE INDEX IF NOT EXISTS idx_transactions_institution ON transactions(institution_id);
                                                      CREATE INDEX IF NOT EXISTS idx_transactions_manual_category ON transactions(manual_category_id);
                                                      CREATE INDEX IF NOT EXISTS idx_category_rules_pattern ON category_rules(pattern);
                                                      CREATE INDEX IF NOT EXISTS idx_type_rules_pattern ON type_rules(pattern);
                       """)
    _seed_default_categories(conn)
    _seed_config(conn)


def _apply_migrations(conn, current):
    migrations = (
        (4, _migrate_v4),
        (5, _migrate_v5),
        (6, _migrate_v6),
        (7, _migrate_v7),
        (8, _migrate_v8),
        (9, _migrate_v9),
        (10, _migrate_v10),
        (11, _migrate_v11),
        (12, _migrate_v12),
        (13, _migrate_v13),
        (14, _migrate_v14),
        (15, _migrate_v15),
        (16, _migrate_v16),
        (17, _migrate_v17),
        (18, _migrate_v18),
        (19, _migrate_v19),
        (20, _migrate_v20),
        (21, _migrate_v21),
        (22, _migrate_v22),
        (23, _migrate_v23),
        (24, _migrate_v24),
        (25, _migrate_v25),
        (26, _migrate_v26),
        (27, _migrate_v27),
    )
    for target, migration in migrations:
        if current < target:
            migration(conn)
    conn.commit()


def _migrate_v4(conn):
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS category_changes (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           transaction_id TEXT NOT NULL,
                           old_category TEXT,
                           new_category TEXT,
                           timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       UPDATE schema_version SET version = 4;
                       """)


def _migrate_v5(conn):
    conn.executescript("""
                       ALTER TABLE transactions ADD COLUMN institution TEXT;
                       CREATE INDEX IF NOT EXISTS idx_transactions_institution ON transactions (institution);
                       UPDATE schema_version SET version = 5;
                       """)


def _migrate_v6(conn):
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS sync_history (
                                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                              env TEXT NOT NULL,
                                                              institution TEXT NOT NULL,
                                                              since TEXT,
                                                              replace INTEGER DEFAULT 0,
                                                              status TEXT NOT NULL,
                                                              added INTEGER DEFAULT 0,
                                                              modified INTEGER DEFAULT 0,
                                                              removed INTEGER DEFAULT 0,
                                                              error TEXT,
                                                              started_at TIMESTAMP,
                                                              finished_at TIMESTAMP
                                                          );
                                                          CREATE INDEX IF NOT EXISTS idx_sync_history_id ON sync_history(id);
                                                          UPDATE schema_version SET version = 6;
                       """)


def _migrate_v7(conn):
    conn.executescript("""
                       ALTER TABLE transactions ADD COLUMN type_override TEXT CHECK(type_override IN ('INCOME','TRANSFER','EXPENSE'));
                                                          CREATE TABLE IF NOT EXISTS type_rules (
                                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                              pattern TEXT NOT NULL,
                                                              transaction_type TEXT NOT NULL CHECK(transaction_type IN ('INCOME','TRANSFER','EXPENSE')),
                                                              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                              UNIQUE(pattern COLLATE NOCASE, transaction_type COLLATE NOCASE)
                                                          );
                                                          CREATE INDEX IF NOT EXISTS idx_type_rules_pattern ON type_rules(pattern);
                                                          UPDATE schema_version SET version = 7;
                       """)
    _seed_default_categories(conn)


def _migrate_v8(conn):
    conn.executescript("""
                       UPDATE transactions SET category = 'Restaurants'
                       WHERE category = 'Food';
                       UPDATE transactions SET category = 'MISC.'
                       WHERE category = 'Miscellaneous';
                       UPDATE transactions SET category = 'Living Expenses'
                       WHERE category = 'Living';
                       UPDATE category_rules SET category = 'Restaurants'
                       WHERE category = 'Food';
                       UPDATE category_rules SET category = 'MISC.'
                       WHERE category = 'Miscellaneous';
                       UPDATE category_rules SET category = 'Living Expenses'
                       WHERE category = 'Living';
                       DELETE FROM categories
                       WHERE name IN ('Food', 'Miscellaneous', 'Living');
                       UPDATE schema_version SET version = 8;
                       """)
    _seed_default_categories(conn)


def _migrate_v9(conn):
    conn.executescript("""
                       ALTER TABLE category_rules ADD COLUMN priority INTEGER DEFAULT 100;
                       ALTER TABLE type_rules ADD COLUMN priority INTEGER DEFAULT 100;
                       CREATE TABLE IF NOT EXISTS taxonomy_mappings (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           taxonomy TEXT NOT NULL,
                           external_key TEXT NOT NULL,
                           external_subkey TEXT,
                           category TEXT NOT NULL,
                           priority INTEGER DEFAULT 0,
                           UNIQUE (taxonomy, external_key, external_subkey)
                       );
                       CREATE TABLE IF NOT EXISTS sheet_layout (
                           position INTEGER NOT NULL,
                           category TEXT NOT NULL,
                           UNIQUE (position),
                           UNIQUE (category)
                       );
                       UPDATE schema_version SET version = 9;
                       """)
    _seed_config(conn)


def _migrate_v10(conn):
    conn.executescript("""
                       ALTER TABLE sync_history ADD COLUMN backfill INTEGER DEFAULT 0;
                       UPDATE schema_version SET version = 10;
                       """)


def _migrate_v11(conn):
    conn.executescript("""
                       UPDATE schema_version SET version = 11;
                       """)


def _migrate_v12(conn):
    conn.executescript("""
                       UPDATE schema_version SET version = 12;
                       """)


def _migrate_v13(conn):
    conn.executescript("""
                       UPDATE transactions SET category = NULL;
                       UPDATE transactions SET
                           category = (
                               SELECT cc.new_category FROM category_changes AS cc
                               WHERE cc.transaction_id = transactions.plaid_transaction_id
                               ORDER BY cc.id DESC LIMIT 1
                           )
                       WHERE plaid_transaction_id IN (SELECT DISTINCT transaction_id FROM category_changes);
                       UPDATE schema_version SET version = 13;
                       """)


def _migrate_v16(conn):
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS settings (
                           key TEXT PRIMARY KEY,
                           value TEXT NOT NULL,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       UPDATE schema_version SET version = 16;
                       """)


def _migrate_v17(conn):
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS category_caps (
                           category_id INTEGER PRIMARY KEY,
                           monthly_cap TEXT NOT NULL,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       UPDATE schema_version SET version = 17;
                       """)


def _migrate_v18(conn):
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS relink_sessions (
                           id TEXT PRIMARY KEY,
                           env TEXT NOT NULL,
                           institution_id INTEGER NOT NULL,
                           history_date TEXT NOT NULL,
                           days_requested INTEGER NOT NULL,
                           status TEXT NOT NULL DEFAULT 'pending',
                           pending_token_label TEXT,
                           new_item_id TEXT,
                           error TEXT,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS webhook_jobs (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           delivery_id TEXT NOT NULL UNIQUE,
                           env TEXT NOT NULL,
                           item_id TEXT NOT NULL,
                           webhook_type TEXT NOT NULL,
                           webhook_code TEXT NOT NULL,
                           initial_update_complete INTEGER,
                           historical_update_complete INTEGER,
                           status TEXT NOT NULL DEFAULT 'pending',
                           attempts INTEGER NOT NULL DEFAULT 0,
                           last_error TEXT,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE INDEX IF NOT EXISTS idx_webhook_jobs_status ON webhook_jobs (status, id);
                       UPDATE schema_version SET version = 18;
                       """)


def _migrate_v19(conn):
    """Add the independent investment ledger without changing depository data."""

    institution_columns = {
        row[1]
        for row in conn.execute("""
                                PRAGMA table_info (institutions)
                                """)
    }
    if "connection_type" not in institution_columns:
        conn.execute(
            """
            ALTER TABLE institutions ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'DEPOSITORY'
            """
        )
    if "status" not in institution_columns:
        conn.execute(
            """
            ALTER TABLE institutions ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETE'
            """
        )
    if "superseded_by_item_id" not in institution_columns:
        conn.execute("""
                     ALTER TABLE institutions ADD COLUMN superseded_by_item_id TEXT
                     """)
    sync_columns = {
        row[1]
        for row in conn.execute("""
                                PRAGMA table_info (sync_history)
                                """)
    }
    if "connection_type" not in sync_columns:
        conn.execute(
            """
            ALTER TABLE sync_history ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'DEPOSITORY'
            """
        )
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS financial_accounts (
                           account_id TEXT PRIMARY KEY, institution_id INTEGER NOT NULL, name TEXT,
                           type TEXT, subtype TEXT, mask TEXT, tax_status TEXT, is_401k INTEGER DEFAULT 0,
                           raw_payload TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS investment_securities (
                           security_id TEXT PRIMARY KEY, ticker TEXT, name TEXT, type TEXT, subtype TEXT,
                           cusip TEXT, isin TEXT, sedol TEXT, currency TEXT, raw_payload TEXT,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS investment_holdings (
                           account_id TEXT NOT NULL, security_id TEXT NOT NULL, quantity DECIMAL,
                           vested_quantity DECIMAL, price DECIMAL, value DECIMAL, cost_basis DECIMAL,
                           tax_lots TEXT, raw_payload TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (account_id, security_id)
                       );
                       CREATE TABLE IF NOT EXISTS investment_holding_snapshots (
                           snapshot_date DATE NOT NULL, account_id TEXT NOT NULL, security_id TEXT NOT NULL,
                           quantity DECIMAL, price DECIMAL, value DECIMAL, cost_basis DECIMAL,
                           raw_payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (snapshot_date, account_id, security_id)
                       );
                       CREATE TABLE IF NOT EXISTS cash_account_snapshots (
                           snapshot_date DATE NOT NULL, account_id TEXT NOT NULL, balance DECIMAL,
                           asset_subtype TEXT, raw_payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (snapshot_date, account_id)
                       );
                       CREATE TABLE IF NOT EXISTS investment_transactions (
                           plaid_transaction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT,
                           date DATE NOT NULL, type TEXT, subtype TEXT, amount DECIMAL, quantity DECIMAL,
                           price DECIMAL, fees DECIMAL, cash_impact DECIMAL, classification TEXT,
                           raw_payload TEXT NOT NULL, source_item_id TEXT, reversed_transaction_id TEXT,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS equity_compensation_events (
                           id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, event_date DATE NOT NULL,
                           security_id TEXT, shares DECIMAL, fair_market_value DECIMAL, gross_income DECIMAL,
                           withholding DECIMAL, net_shares DECIMAL, source TEXT, notes TEXT, raw_payload TEXT,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS transaction_audit_events (
                           id INTEGER PRIMARY KEY AUTOINCREMENT, investment_transaction_id TEXT,
                           event_type TEXT NOT NULL, raw_payload TEXT NOT NULL, normalized_payload TEXT,
                           classification TEXT, previous_classification TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS connection_sync_history (
                           id INTEGER PRIMARY KEY AUTOINCREMENT, institution_id INTEGER NOT NULL,
                           connection_type TEXT NOT NULL, status TEXT NOT NULL, since TEXT, added INTEGER DEFAULT 0,
                           modified INTEGER DEFAULT 0, error TEXT, started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           finished_at TIMESTAMP
                       );
                       CREATE INDEX IF NOT EXISTS idx_investment_transactions_date ON investment_transactions (date);
                       CREATE INDEX IF NOT EXISTS idx_investment_holdings_snapshot_date ON investment_holding_snapshots (snapshot_date);
                       UPDATE schema_version SET version = 19;
                       """)


def _migrate_v20(conn):
    """Add portfolio settings and benchmark/classification storage."""
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS security_classifications (
                           security_id TEXT PRIMARY KEY,
                           asset_class TEXT NOT NULL CHECK (
                               asset_class IN ('US_EQUITY', 'INTERNATIONAL_EQUITY', 'BONDS', 'CASH', 'REAL_ESTATE', 'OTHER')
                           ),
                           source TEXT NOT NULL CHECK (source IN ('SYSTEM', 'PROVIDER', 'USER')),
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS benchmark_prices (
                           benchmark TEXT NOT NULL,
                           price_date DATE NOT NULL,
                           adjusted_close DECIMAL NOT NULL,
                           source TEXT NOT NULL DEFAULT 'yfinance',
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (benchmark, price_date)
                       );
                       CREATE INDEX IF NOT EXISTS idx_benchmark_prices_date ON benchmark_prices (benchmark, price_date);
                       UPDATE schema_version SET version = 20;
                       """)


def _migrate_v21(conn):
    """Add portfolio filters, earmarks, and reconciled cash-flow metadata."""
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS account_preferences (
                           account_id TEXT PRIMARY KEY,
                           tax_status TEXT,
                           liquidity TEXT CHECK (liquidity IN ('LIQUID', 'ILLIQUID')),
                           include_by_default INTEGER NOT NULL DEFAULT 1,
                           is_401k INTEGER,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS cash_earmarks (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           account_id TEXT NOT NULL,
                           name TEXT NOT NULL,
                           amount DECIMAL NOT NULL CHECK (amount >= 0),
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS portfolio_flow_classifications (
                           source_type TEXT NOT NULL CHECK (source_type IN ('DEPOSITORY', 'INVESTMENT')),
                           source_id TEXT NOT NULL,
                           flow_date DATE NOT NULL,
                           account_id TEXT NOT NULL,
                           amount DECIMAL NOT NULL,
                           currency TEXT NOT NULL DEFAULT 'USD',
                           transfer_hint INTEGER NOT NULL DEFAULT 0,
                           flow_type TEXT NOT NULL CHECK (
                               flow_type IN (
                                   'CONTRIBUTION', 'WITHDRAWAL', 'INTERNAL_TRANSFER', 'DIVIDEND', 'INTEREST', 'OTHER_RETURN', 'IGNORE'
                               )
                           ),
                           matched_source_type TEXT,
                           matched_source_id TEXT,
                           source TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (source IN ('SYSTEM', 'USER')),
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (source_type, source_id)
                       );
                       CREATE INDEX IF NOT EXISTS idx_cash_earmarks_account ON cash_earmarks (account_id);
                       CREATE INDEX IF NOT EXISTS idx_portfolio_flows_date ON portfolio_flow_classifications (flow_date);
                       """)
    holding_columns = {
        row[1]
        for row in conn.execute(
            """
            PRAGMA table_info (investment_holding_snapshots)
            """
        )
    }
    if "source" not in holding_columns:
        conn.execute(
            """
            ALTER TABLE investment_holding_snapshots
            ADD COLUMN source TEXT NOT NULL DEFAULT 'PLAID'
            """
        )
    if "is_complete" not in holding_columns:
        conn.execute(
            """
            ALTER TABLE investment_holding_snapshots
            ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1
            """
        )
    cash_columns = {
        row[1]
        for row in conn.execute(
            """
            PRAGMA table_info (cash_account_snapshots)
            """
        )
    }
    if "source" not in cash_columns:
        conn.execute(
            """
            ALTER TABLE cash_account_snapshots
            ADD COLUMN source TEXT NOT NULL DEFAULT 'PLAID'
            """
        )
    if "is_complete" not in cash_columns:
        conn.execute(
            """
            ALTER TABLE cash_account_snapshots
            ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1
            """
        )
    conn.execute(
        """
        UPDATE schema_version SET version = 21
        """
    )
    conn.commit()


def _migrate_v22(conn):
    """Add authoritative snapshot coverage and flexible financial goals."""
    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS portfolio_snapshot_accounts (
                           snapshot_date DATE NOT NULL,
                           account_id TEXT NOT NULL,
                           source TEXT NOT NULL DEFAULT 'PLAID',
                           balance DECIMAL,
                           holdings_count INTEGER NOT NULL DEFAULT 0,
                           is_complete INTEGER NOT NULL DEFAULT 1,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (snapshot_date, account_id)
                       );
                       CREATE INDEX IF NOT EXISTS idx_portfolio_snapshot_accounts_account
                       ON portfolio_snapshot_accounts (account_id, snapshot_date);

                       CREATE TABLE IF NOT EXISTS financial_goals (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           name TEXT NOT NULL,
                           goal_type TEXT NOT NULL DEFAULT 'OTHER',
                           target_amount DECIMAL,
                           target_date DATE,
                           status TEXT NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'COMPLETED')),
                           source_earmark_id INTEGER UNIQUE,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                       );
                       CREATE TABLE IF NOT EXISTS goal_allocations (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           goal_id INTEGER NOT NULL,
                           source_type TEXT NOT NULL CHECK (source_type IN ('ACCOUNT', 'HOLDING')),
                           account_id TEXT NOT NULL,
                           security_id TEXT,
                           assigned_amount DECIMAL NOT NULL CHECK (assigned_amount >= 0),
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           FOREIGN KEY (goal_id) REFERENCES financial_goals (id) ON DELETE CASCADE
                       );
                       CREATE INDEX IF NOT EXISTS idx_goal_allocations_goal
                       ON goal_allocations (goal_id);
                       CREATE INDEX IF NOT EXISTS idx_goal_allocations_source
                       ON goal_allocations (account_id, security_id);

                       INSERT OR IGNORE INTO portfolio_snapshot_accounts
                       (snapshot_date, account_id, source, balance, holdings_count, is_complete)
                       SELECT
                           snapshot_date,
                           account_id,
                           'MIGRATED',
                           SUM(value),
                           COUNT(*),
                           MIN(is_complete)
                       FROM investment_holding_snapshots
                       GROUP BY snapshot_date, account_id;
                       INSERT OR IGNORE INTO portfolio_snapshot_accounts
                       (snapshot_date, account_id, source, balance, holdings_count, is_complete)
                       SELECT
                           snapshot_date,
                           account_id,
                           'MIGRATED',
                           balance,
                           0,
                           is_complete
                       FROM cash_account_snapshots;

                       INSERT OR IGNORE INTO financial_goals
                       (name, goal_type, target_amount, source_earmark_id)
                       SELECT
                           name,
                           'CASH_RESERVE',
                           amount,
                           id
                       FROM cash_earmarks;
                       INSERT INTO goal_allocations
                       (goal_id, source_type, account_id, security_id, assigned_amount)
                       SELECT
                           g.id,
                           'ACCOUNT',
                           e.account_id,
                           NULL,
                           e.amount
                       FROM cash_earmarks AS e
                       INNER JOIN financial_goals AS g ON e.id = g.source_earmark_id
                       WHERE NOT EXISTS (
                           SELECT 1 FROM goal_allocations AS a
                           WHERE
                               a.goal_id = g.id AND a.source_type = 'ACCOUNT'
                               AND a.account_id = e.account_id AND a.security_id IS NULL
                       );
                       """)
    equity_columns = {
        row[1]
        for row in conn.execute(
            """
            PRAGMA table_info (equity_compensation_events)
            """
        )
    }
    if "account_id" not in equity_columns:
        conn.execute(
            """
            ALTER TABLE equity_compensation_events ADD COLUMN account_id TEXT
            """
        )
    if "investment_transaction_id" not in equity_columns:
        conn.execute(
            """
            ALTER TABLE equity_compensation_events
            ADD COLUMN investment_transaction_id TEXT
            """
        )
    account_columns = {
        row[1]
        for row in conn.execute(
            """
            PRAGMA table_info (financial_accounts)
            """
        )
    }
    if "is_active" not in account_columns:
        conn.execute(
            """
            ALTER TABLE financial_accounts
            ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1
            """
        )
    if "inactive_since" not in account_columns:
        conn.execute(
            """
            ALTER TABLE financial_accounts
            ADD COLUMN inactive_since DATE
            """
        )
    conn.execute(
        """
        UPDATE schema_version
        SET version = 22
        """
    )
    conn.commit()


def _migrate_v23(conn):
    """Add household ownership and stable identities to Plaid connections."""

    _converge_v23_schema(conn)
    conn.execute("UPDATE schema_version SET version = 23")
    conn.commit()


def _migrate_v24(conn):
    """Repair databases stamped v23 before the account schema converged."""

    _converge_v23_schema(conn)
    conn.execute("UPDATE schema_version SET version = 24")
    conn.commit()


def _migrate_v25(conn):
    """Replace single security classes with percentage allocation breakdowns."""

    conn.executescript("""
                       CREATE TABLE IF NOT EXISTS security_asset_allocations (
                           security_id TEXT NOT NULL,
                           asset_class TEXT NOT NULL CHECK (
                               asset_class IN (
                                   'US_EQUITY',
                                   'INTERNATIONAL_EQUITY',
                                   'BONDS',
                                   'CASH',
                                   'REAL_ESTATE',
                                   'OTHER'
                               )
                           ),
                           allocation_percent DECIMAL NOT NULL CHECK (
                               allocation_percent > 0 AND allocation_percent <= 100
                           ),
                           source TEXT NOT NULL CHECK (
                               source IN ('SYSTEM', 'PROVIDER', 'USER')
                           ),
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           PRIMARY KEY (security_id, asset_class)
                       );
                       """)
    legacy_table = conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'security_classifications'
        """
    ).fetchone()
    if legacy_table:
        conn.executescript("""
                           INSERT OR IGNORE INTO security_asset_allocations (
                               security_id,
                               asset_class,
                               allocation_percent,
                               source,
                               updated_at
                           )
                           SELECT
                               security_id,
                               asset_class,
                               100,
                               source,
                               updated_at
                           FROM security_classifications;
                           DROP TABLE security_classifications;
                           """)
    conn.execute("UPDATE schema_version SET version = 25")
    conn.commit()


def _migrate_v26(conn):
    """Add household and per-owner scope to financial goals."""

    goal_columns = {
        row[1] for row in conn.execute("PRAGMA table_info (financial_goals)")
    }
    if "scope" not in goal_columns:
        conn.execute(
            "ALTER TABLE financial_goals ADD COLUMN scope TEXT NOT NULL DEFAULT 'HOUSEHOLD'"
        )
    if "owner_user_id" not in goal_columns:
        conn.execute("ALTER TABLE financial_goals ADD COLUMN owner_user_id TEXT")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_financial_goals_scope_owner
        ON financial_goals (scope, owner_user_id)
        """
    )
    conn.execute("UPDATE schema_version SET version = 26")
    conn.commit()


def _migrate_v27(conn):
    """Add normalized account categories and balance-only asset allocations."""

    preference_columns = {
        row[1] for row in conn.execute("PRAGMA table_info (account_preferences)")
    }
    if "account_category" not in preference_columns:
        conn.execute(
            """
            ALTER TABLE account_preferences
            ADD COLUMN account_category TEXT CHECK (
                account_category IN (
                    'CASH',
                    'BROKERAGE',
                    'RETIREMENT',
                    'EDUCATION',
                    'HEALTH_SAVINGS',
                    'EQUITY_COMPENSATION',
                    'OTHER'
                )
            )
            """
        )
        conn.execute(
            """
            UPDATE account_preferences
            SET account_category = CASE
                WHEN tax_status = 'RETIREMENT' THEN 'RETIREMENT'
                WHEN tax_status = 'TAXABLE' AND EXISTS (
                    SELECT 1
                    FROM financial_accounts
                    WHERE
                        financial_accounts.account_id = account_preferences.account_id
                        AND financial_accounts.type = 'depository'
                ) THEN 'CASH'
                WHEN tax_status = 'TAXABLE' THEN 'BROKERAGE'
                ELSE NULL
            END
            WHERE tax_status IS NOT NULL
            """
        )
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS account_asset_allocations (
            account_id TEXT NOT NULL,
            asset_class TEXT NOT NULL CHECK (
                asset_class IN (
                    'US_EQUITY',
                    'INTERNATIONAL_EQUITY',
                    'BONDS',
                    'CASH',
                    'REAL_ESTATE',
                    'OTHER'
                )
            ),
            allocation_percent DECIMAL NOT NULL CHECK (
                allocation_percent > 0 AND allocation_percent <= 100
            ),
            source TEXT NOT NULL DEFAULT 'USER' CHECK (source = 'USER'),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (account_id, asset_class)
        );
        CREATE INDEX IF NOT EXISTS idx_account_asset_allocations_account
        ON account_asset_allocations (account_id);
        UPDATE schema_version SET version = 27;
        """
    )
    conn.commit()


def _converge_v23_schema(conn) -> None:
    _add_v23_institution_columns(conn)
    conn.execute(
        """
        UPDATE institutions
        SET
            connection_uuid = COALESCE(connection_uuid, lower(hex(randomblob(16)))),
            institution_name = COALESCE(institution_name, name)
        """
    )
    _create_v23_household_tables(conn)
    _add_v23_account_columns(conn)
    _backfill_v23_accounts(conn)


def _add_v23_institution_columns(conn) -> None:

    institution_columns = {
        row[1] for row in conn.execute("PRAGMA table_info (institutions)")
    }
    if "connection_uuid" not in institution_columns:
        conn.execute("ALTER TABLE institutions ADD COLUMN connection_uuid TEXT")
    if "institution_name" not in institution_columns:
        conn.execute("ALTER TABLE institutions ADD COLUMN institution_name TEXT")
    if "plaid_institution_id" not in institution_columns:
        conn.execute("ALTER TABLE institutions ADD COLUMN plaid_institution_id TEXT")
    if "household_id" not in institution_columns:
        conn.execute("ALTER TABLE institutions ADD COLUMN household_id TEXT")
    if "owner_user_id" not in institution_columns:
        conn.execute("ALTER TABLE institutions ADD COLUMN owner_user_id TEXT")


def _create_v23_household_tables(conn) -> None:
    conn.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_connection_uuid
        ON institutions (connection_uuid);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_item_id
        ON institutions (plaid_item_id) WHERE plaid_item_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS household_scope (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            household_id TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS household_accounts (
            id TEXT PRIMARY KEY,
            household_id TEXT,
            display_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS account_owners (
            household_account_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (household_account_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS account_merge_suggestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            candidate_account_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'MERGED', 'DISMISSED')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (account_id, candidate_account_id)
        );
        """
    )


def _add_v23_account_columns(conn) -> None:
    account_columns = {
        row[1] for row in conn.execute("PRAGMA table_info (financial_accounts)")
    }
    if "household_account_id" not in account_columns:
        conn.execute(
            "ALTER TABLE financial_accounts ADD COLUMN household_account_id TEXT"
        )
    if "persistent_account_id" not in account_columns:
        conn.execute(
            "ALTER TABLE financial_accounts ADD COLUMN persistent_account_id TEXT"
        )
    if "is_authoritative" not in account_columns:
        conn.execute(
            """
            ALTER TABLE financial_accounts
            ADD COLUMN is_authoritative INTEGER NOT NULL DEFAULT 1
            """
        )
    if "original_household_account_id" not in account_columns:
        conn.execute(
            """
            ALTER TABLE financial_accounts
            ADD COLUMN original_household_account_id TEXT
            """
        )


def _backfill_v23_accounts(conn) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO financial_accounts
        (account_id, institution_id, name, type, raw_payload)
        SELECT DISTINCT
            account_id,
            institution_id,
            account_id,
            'depository',
            '{}'
        FROM transactions
        WHERE account_id <> ''
        """
    )
    accounts = conn.execute(
        "SELECT account_id, name FROM financial_accounts"
    ).fetchall()
    for account in accounts:
        canonical_id = f"acct_{account['account_id']}"
        conn.execute(
            """
            INSERT OR IGNORE INTO household_accounts (id, display_name)
            VALUES (?, ?)
            """,
            (canonical_id, account["name"] or account["account_id"]),
        )
        conn.execute(
            """
            UPDATE financial_accounts
            SET household_account_id = COALESCE(household_account_id, ?)
            WHERE account_id = ?
            """,
            (canonical_id, account["account_id"]),
        )
        conn.execute(
            """
            UPDATE financial_accounts
            SET original_household_account_id = COALESCE(original_household_account_id, ?)
            WHERE account_id = ?
            """,
            (canonical_id, account["account_id"]),
        )


def _migrate_v14(conn):

    seed_cat_patterns = sorted(
        {p.upper() for p in MERCHANT_CATEGORY_OVERRIDES}
        | {p.upper() for p in SPECIFIC_CATEGORY_OVERRIDES}
    )
    seed_type_patterns = sorted({p.upper() for p, _, _ in SEED_TYPE_KEYWORDS})

    conn.executescript("""
                       ALTER TABLE institutions ADD COLUMN created_at TIMESTAMP;
                       ALTER TABLE institutions ADD COLUMN updated_at TIMESTAMP;
                       ALTER TABLE categories ADD COLUMN updated_at TIMESTAMP;
                       CREATE TEMP TABLE migration_seed_category_patterns (pattern TEXT PRIMARY KEY);
                       CREATE TEMP TABLE migration_seed_type_patterns (pattern TEXT PRIMARY KEY);
                       """)
    conn.executemany(
        """
        INSERT INTO migration_seed_category_patterns (pattern) VALUES (?)
        """,
        ((pattern,) for pattern in seed_cat_patterns),
    )
    conn.executemany(
        """
        INSERT INTO migration_seed_type_patterns (pattern) VALUES (?)
        """,
        ((pattern,) for pattern in seed_type_patterns),
    )
    conn.execute(
        """
        UPDATE institutions SET
            created_at = COALESCE(created_at, CURRENT_TIMESTAMP), updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
        """
    )
    conn.execute("""
                 UPDATE categories SET updated_at = COALESCE(updated_at, created_at)
                 """)
    conn.executescript("""
                       INSERT OR IGNORE INTO categories (name)
                       SELECT DISTINCT category
                       FROM transactions
                       WHERE category IS NOT NULL AND category <> '';
                       INSERT OR IGNORE INTO categories (name)
                       SELECT DISTINCT category
                       FROM category_rules
                       WHERE category IS NOT NULL AND category <> '';
                       INSERT OR IGNORE INTO categories (name)
                       SELECT DISTINCT category
                       FROM taxonomy_mappings
                       WHERE category IS NOT NULL AND category <> '';
                       INSERT OR IGNORE INTO categories (name)
                       SELECT DISTINCT category
                       FROM sheet_layout
                       WHERE category IS NOT NULL AND category <> '';
                       """)
    conn.executescript(
        """
        CREATE TABLE transactions_new (
                            plaid_transaction_id TEXT PRIMARY KEY,
                            account_id TEXT NOT NULL,
                            institution_id INTEGER,
                            date DATE NOT NULL,
                            amount DECIMAL(12,2) NOT NULL,
                            merchant TEXT,
                            raw_description TEXT,
                            manual_category_id INTEGER,
                            manual_category_set_at TIMESTAMP,
                            type_override TEXT CHECK(type_override IN ('INCOME','TRANSFER','EXPENSE')),
                            is_ignored INTEGER DEFAULT 0,
                            pending INTEGER DEFAULT 0,
                            currency TEXT DEFAULT 'USD',
                            plaid_category TEXT,
                            plaid_subcategory TEXT,
                            pfc_primary TEXT,
                            pfc_detailed TEXT,
                            payment_processor TEXT,
                            removed INTEGER DEFAULT 0,
                            created_at TIMESTAMP,
                            updated_at TIMESTAMP
                        );
                        INSERT INTO transactions_new (plaid_transaction_id, account_id, institution_id, date, amount, merchant, raw_description, manual_category_id, manual_category_set_at, type_override, is_ignored, pending, currency, plaid_category, plaid_subcategory, pfc_primary, pfc_detailed, payment_processor, removed, created_at, updated_at)
                        SELECT t.plaid_transaction_id, t.account_id,
                               (SELECT i.id FROM institutions i WHERE i.name = t.institution),
                               t.date, t.amount, t.merchant, t.raw_description,
                               NULL, NULL,
                               t.type_override, t.is_ignored, t.pending, t.currency,
                               t.plaid_category, t.plaid_subcategory, t.pfc_primary, t.pfc_detailed, t.payment_processor, t.removed,
                               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        FROM transactions t;
                        DROP TABLE transactions;
                        ALTER TABLE transactions_new RENAME TO transactions;
                        CREATE INDEX IF NOT EXISTS idx_transactions_institution ON transactions(institution_id);
                        CREATE INDEX IF NOT EXISTS idx_transactions_manual_category ON transactions(manual_category_id);

                        CREATE TABLE category_rules_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            pattern TEXT NOT NULL,
                            match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                            category_id INTEGER NOT NULL,
                            priority INTEGER DEFAULT 100,
                            source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                            enabled INTEGER DEFAULT 1,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(pattern COLLATE NOCASE, match_type)
                        );
                        INSERT INTO category_rules_new (pattern, match_type, category_id, priority, source, enabled, created_at, updated_at)
                        SELECT pattern, 'BOTH', (SELECT c.id FROM categories c WHERE c.name = category_rules.category), priority,
                               CASE
                                   WHEN UPPER(pattern) IN (SELECT pattern FROM migration_seed_category_patterns)
                                       THEN 'seed'
                                   ELSE 'user'
                               END, 1, created_at, CURRENT_TIMESTAMP
                        FROM category_rules;
                        DROP TABLE category_rules;
                        ALTER TABLE category_rules_new RENAME TO category_rules;
                        CREATE INDEX IF NOT EXISTS idx_category_rules_pattern ON category_rules(pattern);

                        CREATE TABLE type_rules_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            pattern TEXT NOT NULL,
                            match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                            transaction_type TEXT NOT NULL CHECK(transaction_type IN ('INCOME','TRANSFER','EXPENSE')),
                            priority INTEGER DEFAULT 100,
                            source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                            enabled INTEGER DEFAULT 1,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(pattern COLLATE NOCASE, match_type)
                        );
                        INSERT INTO type_rules_new (pattern, match_type, transaction_type, priority, source, enabled, created_at, updated_at)
                        SELECT pattern, 'BOTH', transaction_type, priority,
                               CASE
                                   WHEN UPPER(pattern) IN (SELECT pattern FROM migration_seed_type_patterns)
                                       THEN 'seed'
                                   ELSE 'user'
                               END, 1, created_at, CURRENT_TIMESTAMP
                        FROM type_rules;
                        DROP TABLE type_rules;
                        ALTER TABLE type_rules_new RENAME TO type_rules;

                        CREATE TABLE taxonomy_mappings_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            taxonomy TEXT NOT NULL CHECK(taxonomy IN ('pfc','legacy')),
                            external_key TEXT NOT NULL,
                            external_subkey TEXT,
                            category_id INTEGER NOT NULL,
                            priority INTEGER DEFAULT 0,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(taxonomy, external_key, external_subkey)
                        );
                        INSERT INTO taxonomy_mappings_new (taxonomy, external_key, external_subkey, category_id, priority, created_at, updated_at)
                        SELECT taxonomy, external_key, external_subkey, (SELECT c.id FROM categories c WHERE c.name = taxonomy_mappings.category), priority, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        FROM taxonomy_mappings;
                        DROP TABLE taxonomy_mappings;
                        ALTER TABLE taxonomy_mappings_new RENAME TO taxonomy_mappings;

                        CREATE TABLE sheet_layout_new (
                            position INTEGER NOT NULL,
                            category_id INTEGER NOT NULL,
                            UNIQUE(position),
                            UNIQUE(category_id)
                        );
                        INSERT INTO sheet_layout_new (position, category_id)
                        SELECT position, (SELECT c.id FROM categories c WHERE c.name = sheet_layout.category) FROM sheet_layout;
                        DROP TABLE sheet_layout;
                        ALTER TABLE sheet_layout_new RENAME TO sheet_layout;

                        CREATE TABLE category_changes_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            transaction_id TEXT NOT NULL,
                            from_category_id INTEGER,
                            to_category_id INTEGER,
                            reason TEXT NOT NULL DEFAULT 'MANUAL' CHECK(reason IN ('MANUAL','RULE','AI','IMPORT')),
                            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                        INSERT INTO category_changes_new (transaction_id, from_category_id, to_category_id, reason, timestamp)
                        SELECT transaction_id,
                               (SELECT c.id FROM categories c WHERE c.name = category_changes.old_category),
                               (SELECT c.id FROM categories c WHERE c.name = category_changes.new_category),
                               'MANUAL', timestamp
                        FROM category_changes;
                        DROP TABLE category_changes;
                        ALTER TABLE category_changes_new RENAME TO category_changes;

                        CREATE TABLE sync_history_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            env TEXT NOT NULL,
                            institution_id INTEGER,
                            since TEXT,
                            replace INTEGER DEFAULT 0,
                            backfill INTEGER DEFAULT 0,
                            status TEXT NOT NULL,
                            added INTEGER DEFAULT 0,
                            modified INTEGER DEFAULT 0,
                            removed INTEGER DEFAULT 0,
                            error TEXT,
                            started_at TIMESTAMP,
                            finished_at TIMESTAMP,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                        INSERT INTO sync_history_new (env, institution_id, since, replace, backfill, status, added, modified, removed, error, started_at, finished_at, created_at, updated_at)
                        SELECT env, (SELECT i.id FROM institutions i WHERE i.name = sync_history.institution), since, replace, backfill, status, added, modified, removed, error, started_at, finished_at, started_at, finished_at
                        FROM sync_history;
                        DROP TABLE sync_history;
                        ALTER TABLE sync_history_new RENAME TO sync_history;
                        CREATE INDEX IF NOT EXISTS idx_sync_history_id ON sync_history(id);
                        DROP TABLE migration_seed_category_patterns;
                        DROP TABLE migration_seed_type_patterns;
        """
    )
    conn.execute("""
                 UPDATE schema_version SET version = 14
                 """)
    _seed_config(conn)


def _migrate_v15(conn):
    conn.executescript("""
                       CREATE TABLE category_rules_new (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          pattern TEXT NOT NULL,
                                                          match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                                                          category_id INTEGER NOT NULL,
                                                          priority INTEGER DEFAULT 100,
                                                          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                                                          enabled INTEGER DEFAULT 1,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          UNIQUE(pattern COLLATE NOCASE, match_type)
                                                      );
                                                      INSERT INTO category_rules_new (pattern, match_type, category_id, priority, source, enabled, created_at, updated_at)
                                                      SELECT cr.pattern, cr.match_type, cr.category_id, cr.priority, cr.source, cr.enabled, cr.created_at, cr.updated_at
                                                      FROM category_rules cr
                                                      WHERE cr.id = (
                                                          SELECT c2.id FROM category_rules c2
                                                          WHERE c2.pattern COLLATE NOCASE = cr.pattern COLLATE NOCASE AND c2.match_type = cr.match_type
                                                          ORDER BY c2.priority DESC, c2.id DESC LIMIT 1
                                                      );
                                                      DROP TABLE category_rules;
                                                      ALTER TABLE category_rules_new RENAME TO category_rules;
                                                      CREATE INDEX IF NOT EXISTS idx_category_rules_pattern ON category_rules(pattern);

                                                      CREATE TABLE type_rules_new (
                                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                          pattern TEXT NOT NULL,
                                                          match_type TEXT NOT NULL DEFAULT 'BOTH' CHECK(match_type IN ('MERCHANT','DESCRIPTION','BOTH','REGEX','PREFIX','EXACT')),
                                                          transaction_type TEXT NOT NULL CHECK(transaction_type IN ('INCOME','TRANSFER','EXPENSE')),
                                                          priority INTEGER DEFAULT 100,
                                                          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('seed','user','system','ai')),
                                                          enabled INTEGER DEFAULT 1,
                                                          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                          UNIQUE(pattern COLLATE NOCASE, match_type)
                                                      );
                                                      INSERT INTO type_rules_new (pattern, match_type, transaction_type, priority, source, enabled, created_at, updated_at)
                                                      SELECT tr.pattern, tr.match_type, tr.transaction_type, tr.priority, tr.source, tr.enabled, tr.created_at, tr.updated_at
                                                      FROM type_rules tr
                                                      WHERE tr.id = (
                                                          SELECT t2.id FROM type_rules t2
                                                          WHERE t2.pattern COLLATE NOCASE = tr.pattern COLLATE NOCASE AND t2.match_type = tr.match_type
                                                          ORDER BY t2.priority DESC, t2.id DESC LIMIT 1
                                                      );
                                                      DROP TABLE type_rules;
                                                      ALTER TABLE type_rules_new RENAME TO type_rules;
                                                      CREATE INDEX IF NOT EXISTS idx_type_rules_pattern ON type_rules(pattern);
                       """)
    conn.execute("""
                 UPDATE schema_version SET version = 15
                 """)
