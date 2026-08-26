from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.storage.repository import (
    create_category,
    delete_category,
    delete_category_rule,
    ensure_category,
    get_category_caps,
    get_category_id_by_name,
    get_category_ids,
    get_category_names,
    get_category_rules,
    set_category_cap,
    set_category_rule_enabled,
    upsert_category_rule,
)

router = APIRouter(prefix="/api", tags=["categories"])


class CategoryCreate(BaseModel):
    name: str


class RuleCreate(BaseModel):
    pattern: str
    category: str
    match_type: str = "BOTH"
    priority: int = 100


class RuleUpdate(BaseModel):
    enabled: bool


class CategoryCapUpdate(BaseModel):
    category: str
    cap: str | None = None


def parse_cap_amount(raw: str | None) -> Decimal | None:
    if raw is None:
        return None
    cleaned = raw.strip().replace("$", "").replace(",", "").replace(" ", "")
    if cleaned == "":
        return None
    return Decimal(cleaned)


@router.get("/category-caps")
def list_category_caps(env: EnvDep, db: DbDep):
    conn, _ = db

    caps = get_category_caps(conn)
    ids = get_category_ids(conn)
    return {"caps": {name: str(caps[cid]) for name, cid in ids.items() if cid in caps}}


@router.put("/category-caps")
def update_category_cap(req: CategoryCapUpdate, env: EnvDep, db: DbDep):
    conn, _ = db

    name = req.category.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category required")
    category_id = get_category_id_by_name(conn, name)
    if category_id is None:
        raise HTTPException(status_code=404, detail="Category not found")
    try:
        amount = parse_cap_amount(req.cap)
    except InvalidOperation:
        raise HTTPException(status_code=400, detail="Invalid cap amount")
    if amount is None:
        set_category_cap(conn, category_id, None)
    elif amount < 0:
        raise HTTPException(status_code=400, detail="Cap must be non-negative")
    else:
        set_category_cap(conn, category_id, amount)
    return {"ok": True, "category": name, "cap": req.cap}


@router.get("/categories")
def list_categories(env: EnvDep, db: DbDep):
    conn, _ = db

    names = get_category_names(conn)
    return {"categories": names}


@router.post("/categories")
def create_cat(req: CategoryCreate, env: EnvDep, db: DbDep):
    conn, _ = db

    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name required")
    create_category(conn, req.name.strip())
    return {"ok": True, "name": req.name.strip()}


@router.delete("/categories/{name}")
def delete_cat(name: str, env: EnvDep, db: DbDep):
    conn, _ = db

    delete_category(conn, name)
    return {"ok": True}


@router.get("/category-rules")
def list_rules(env: EnvDep, db: DbDep):
    conn, _ = db

    rules = get_category_rules(conn)
    return {
        "rules": [
            {
                "id": r.id,
                "pattern": r.pattern,
                "match_type": r.match_type,
                "category": r.category,
                "priority": r.priority,
                "source": r.source,
                "enabled": r.enabled,
                "created_at": str(r.created_at),
            }
            for r in rules
        ]
    }


@router.post("/category-rules")
def create_rule(req: RuleCreate, env: EnvDep, db: DbDep):
    conn, _ = db

    if not req.pattern.strip() or not req.category.strip():
        raise HTTPException(status_code=400, detail="Pattern and category required")
    if req.match_type not in (
        "MERCHANT",
        "DESCRIPTION",
        "BOTH",
        "REGEX",
        "PREFIX",
        "EXACT",
    ):
        raise HTTPException(status_code=400, detail="Invalid match_type")
    category_id = ensure_category(conn, req.category.strip())
    upsert_category_rule(
        conn,
        req.pattern.strip(),
        category_id,
        match_type=req.match_type,
        priority=req.priority,
        source="user",
    )
    return {"ok": True}


@router.put("/category-rules/{rule_id}")
def update_rule(rule_id: int, req: RuleUpdate, env: EnvDep, db: DbDep):
    conn, _ = db

    set_category_rule_enabled(conn, rule_id, req.enabled)
    return {"ok": True, "enabled": req.enabled}


@router.delete("/category-rules/{rule_id}")
def delete_rule(rule_id: int, env: EnvDep, db: DbDep):
    conn, _ = db

    delete_category_rule(conn, rule_id)
    return {"ok": True}
