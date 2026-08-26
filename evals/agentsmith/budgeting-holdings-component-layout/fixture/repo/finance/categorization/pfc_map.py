from typing import TypedDict

from finance.storage.repository import get_taxonomy_mappings


class PFCEntry(TypedDict):
    primary: str
    detailed_map: dict[str, str]


PFC_CATEGORY_MAP: dict[str, PFCEntry] = {
    "FOOD_AND_DRINK": {
        "primary": "Restaurants",
        "detailed_map": {
            "RESTAURANTS": "Restaurants",
            "FAST_FOOD": "Restaurants",
            "COFFEE": "Restaurants",
            "GROCERIES": "Groceries",
        },
    },
    "TRANSPORTATION": {
        "primary": "Transportation",
        "detailed_map": {
            "RIDE_SHARE": "Transportation",
            "GAS": "Transportation",
            "PARKING": "Transportation",
            "TOLLS": "Transportation",
        },
    },
    "RENT_AND_UTILITIES": {
        "primary": "Living Expenses",
        "detailed_map": {},
    },
    "TRAVEL": {
        "primary": "Travel",
        "detailed_map": {
            "AIRLINES": "Travel",
            "HOTELS": "Travel",
            "RENTAL_CARS": "Travel",
        },
    },
    "PETS": {
        "primary": "Cat Related",
        "detailed_map": {
            "PET_FOOD": "Cat Related",
            "PET_SUPPLIES": "Cat Related",
            "PET_GROOMING": "Cat Related",
            "VETERINARY": "Cat Related",
        },
    },
    "GENERAL_SERVICES": {
        "primary": "MISC.",
        "detailed_map": {},
    },
    "GENERAL_MERCHANDISE": {
        "primary": "MISC.",
        "detailed_map": {},
    },
    "ENTERTAINMENT": {
        "primary": "MISC.",
        "detailed_map": {},
    },
}


LEGACY_CATEGORY_MAP: dict = {
    "Food and Drink": "Restaurants",
    "Travel": "Travel",
    "Shops": "MISC.",
    "Recreation": "MISC.",
    "Payment": None,
    "Transfer": None,
}

MERCHANT_CATEGORY_OVERRIDES = {
    "CHEWY": "Cat Related",
    "DAYCARE": "Baby",
    "1POINT3ACRE": "MISC.",
}

SPECIFIC_CATEGORY_OVERRIDES = {
    "AMAZON PRIME": "MISC.",
    "AMAZON PRIME VIDEO": "MISC.",
    "AMAZON KINDLE": "MISC.",
    "AMAZON WEB SERVICES": "MISC.",
}

SEED_TYPE_KEYWORDS = [
    ("CREDIT CARD", "TRANSFER", 50),
    ("PAYMENT *//", "TRANSFER", 50),
    ("AUTOMATIC PAYMENT", "TRANSFER", 50),
    ("BILT PMT", "TRANSFER", 50),
    ("BILT PAYMENT", "TRANSFER", 50),
    ("GUSTO", "INCOME", 40),
    ("PAYROLL", "INCOME", 40),
    ("DIRECT DEP", "INCOME", 40),
    ("INTRST PYMNT", "INCOME", 40),
    ("DEPOSIT@", "INCOME", 40),
    ("CD DEPOSIT", "TRANSFER", 30),
]


def mappings_from_constants() -> list[dict]:
    mappings = []
    for primary, entry in PFC_CATEGORY_MAP.items():
        mappings.append(
            {
                "taxonomy": "pfc",
                "external_key": primary,
                "external_subkey": None,
                "category": entry["primary"],
                "priority": 0,
            }
        )
        for d, cat in entry["detailed_map"].items():
            mappings.append(
                {
                    "taxonomy": "pfc",
                    "external_key": primary,
                    "external_subkey": d,
                    "category": cat,
                    "priority": 0,
                }
            )
    for legacy, cat in LEGACY_CATEGORY_MAP.items():
        if cat:
            mappings.append(
                {
                    "taxonomy": "legacy",
                    "external_key": legacy,
                    "external_subkey": None,
                    "category": cat,
                    "priority": 0,
                }
            )
    return mappings


def map_legacy_category(conn, plaid_category: list | None, mappings=None) -> str | None:
    if not plaid_category:
        return None
    if mappings is None:
        mappings = get_taxonomy_mappings(conn)
    key = plaid_category[0]
    for m in mappings:
        if m["taxonomy"] == "legacy" and m["external_key"] == key:
            return m["category"]
    return None


def map_pfc(
    conn, pfc_primary: str | None, pfc_detailed: str | None, mappings=None
) -> str | None:
    if not pfc_primary:
        return None
    if mappings is None:
        mappings = get_taxonomy_mappings(conn)
    detailed = _find_pfc_mapping(mappings, pfc_primary, pfc_detailed)
    if detailed is not None:
        return detailed
    return _find_pfc_mapping(mappings, pfc_primary, None)


def _find_pfc_mapping(mappings, primary, detailed) -> str | None:
    for mapping in mappings:
        key = (mapping["taxonomy"], mapping["external_key"], mapping["external_subkey"])
        if key == ("pfc", primary, detailed):
            return mapping["category"]
    return None


def _matches_seeded_category_rule(category_rules, txn) -> bool:
    if not category_rules:
        return False
    name = ((txn.merchant or "") + " " + (txn.raw_description or "")).upper()
    for r in category_rules:
        if r.priority == 0 and r.pattern and r.pattern.upper() in name:
            return True
    return False


def classify_txn(txn, category_rules=None) -> str:
    if txn.type_override:
        return txn.type_override.lower()
    name = (txn.merchant or txn.raw_description or "").upper()

    if _is_bilt_payment(name):
        return "transfer"

    pfc = txn.pfc_primary
    if pfc in ("TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"):
        if _is_payment_service(txn, name, category_rules):
            return "income" if txn.amount < 0 else "expense"
        return "transfer"

    if txn.amount > 0:
        return "expense"
    return "income"


def _is_bilt_payment(name: str) -> bool:
    return "BILT" in name and any(marker in name for marker in ("PMT", "PAYMENT"))


def _is_payment_service(txn, name: str, category_rules) -> bool:
    return (
        txn.payment_processor == "PayPal"
        or "VENMO" in name
        or _matches_seeded_category_rule(category_rules, txn)
    )
