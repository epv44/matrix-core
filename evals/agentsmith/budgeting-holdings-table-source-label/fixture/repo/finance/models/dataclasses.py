from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal


@dataclass
class Institution:
    id: int | None = None
    name: str = ""
    plaid_item_id: str | None = None
    cursor: str | None = None
    last_successful_sync: datetime | None = None
    token_created_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    connection_type: str = "DEPOSITORY"
    status: str = "COMPLETE"
    superseded_by_item_id: str | None = None
    connection_uuid: str | None = None
    institution_name: str | None = None
    plaid_institution_id: str | None = None
    household_id: str | None = None
    owner_user_id: str | None = None


@dataclass
class Transaction:
    plaid_transaction_id: str = ""
    account_id: str = ""
    institution_id: int | None = None
    institution: str | None = None
    date: datetime = field(default_factory=datetime.now)
    amount: Decimal = Decimal("0.00")
    merchant: str | None = None
    raw_description: str | None = None
    manual_category_id: int | None = None
    manual_category_set_at: datetime | None = None
    category: str | None = None
    transaction_type: str | None = None
    type_override: str | None = None
    is_ignored: bool = False
    pending: bool = False
    currency: str = "USD"
    plaid_category: str | None = None
    plaid_subcategory: str | None = None
    pfc_primary: str | None = None
    pfc_detailed: str | None = None
    payment_processor: str | None = None
    removed: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Category:
    id: int | None = None
    name: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class CategoryRule:
    id: int | None = None
    pattern: str = ""
    match_type: str = "BOTH"
    category_id: int = 0
    category: str | None = None
    priority: int = 100
    source: str = "user"
    enabled: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class TypeRule:
    id: int | None = None
    pattern: str = ""
    match_type: str = "BOTH"
    transaction_type: str = ""
    priority: int = 100
    source: str = "user"
    enabled: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class CategoryChange:
    id: int | None = None
    transaction_id: str = ""
    from_category_id: int | None = None
    to_category_id: int | None = None
    reason: str = "MANUAL"
    timestamp: datetime | None = None
    old_category: str | None = None
    new_category: str | None = None
