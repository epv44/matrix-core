from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.models.setting_keys import SettingKey
from finance.storage.repository import (
    get_setting,
    get_target_allocation,
    set_setting,
    set_target_allocation,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingUpdate(BaseModel):
    key: str
    value: str


class TargetAllocationUpdate(BaseModel):
    us_stock: float
    international_stock: float
    bond_market: float


@router.get("")
def list_settings(env: EnvDep, db: DbDep):
    conn, _ = db

    return {
        "settings": {
            SettingKey.MONTHLY_BUDGET: get_setting(conn, SettingKey.MONTHLY_BUDGET),
            SettingKey.TARGET_US_EQUITY: get_setting(conn, SettingKey.TARGET_US_EQUITY),
            SettingKey.TARGET_INTERNATIONAL_EQUITY: get_setting(
                conn, SettingKey.TARGET_INTERNATIONAL_EQUITY
            ),
            SettingKey.TARGET_BONDS: get_setting(conn, SettingKey.TARGET_BONDS),
        }
    }


@router.put("")
def update_setting(req: SettingUpdate, env: EnvDep, db: DbDep):
    conn, _ = db

    if req.key not in {s.value for s in SettingKey}:
        raise HTTPException(status_code=400, detail="Unknown setting key")
    set_setting(conn, req.key, req.value)
    return {"ok": True, "key": req.key, "value": req.value}


@router.get("/investment-target")
def get_investment_target(env: EnvDep, db: DbDep):
    conn, _ = db

    target = get_target_allocation(conn)
    return {
        "us_stock": target["US_EQUITY"],
        "international_stock": target["INTERNATIONAL_EQUITY"],
        "bond_market": target["BONDS"],
    }


@router.put("/investment-target")
def update_investment_target(payload: TargetAllocationUpdate, env: EnvDep, db: DbDep):
    conn, _ = db

    try:
        target = set_target_allocation(
            conn, payload.us_stock, payload.international_stock, payload.bond_market
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "us_stock": target["US_EQUITY"],
        "international_stock": target["INTERNATIONAL_EQUITY"],
        "bond_market": target["BONDS"],
    }
