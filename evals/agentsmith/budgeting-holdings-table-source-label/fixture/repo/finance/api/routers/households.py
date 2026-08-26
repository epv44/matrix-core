"""Household account administration."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.api.routers.auth import _require_admin
from finance.config.settings import load_config
from finance.security.auth import request_user
from finance.storage.identity import identity_connection, list_members
from finance.storage.repositories.households import (
    list_household_accounts,
    list_household_connections,
    list_merge_suggestions,
    merge_provider_accounts,
    promote_provider_account,
    set_account_owners,
    split_provider_account,
)

router = APIRouter(prefix="/api/household", tags=["household"])


class MergeRequest(BaseModel):
    primary_account_id: str
    secondary_account_id: str


class OwnersRequest(BaseModel):
    user_ids: list[str]


class PromoteRequest(BaseModel):
    account_id: str


@router.get("/accounts")
def accounts(env: EnvDep, db: DbDep, request: Request):
    conn, _ = db
    user = request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    identity = identity_connection(load_config()["identity_db_path"])
    try:
        members = list_members(identity, user["household_id"])
    finally:
        identity.close()
    return {
        "accounts": list_household_accounts(conn),
        "connections": list_household_connections(conn),
        "suggestions": list_merge_suggestions(conn),
        "members": members,
    }


@router.post("/accounts/merge")
def merge(payload: MergeRequest, env: EnvDep, db: DbDep, request: Request):
    _require_admin(request)
    conn, _ = db
    try:
        merge_provider_accounts(
            conn, payload.primary_account_id, payload.secondary_account_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/accounts/{account_id}/split")
def split(account_id: str, env: EnvDep, db: DbDep, request: Request):
    _require_admin(request)
    conn, _ = db
    try:
        split_provider_account(conn, account_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.put("/accounts/{household_account_id}/owners")
def owners(
    household_account_id: str,
    payload: OwnersRequest,
    env: EnvDep,
    db: DbDep,
    request: Request,
):
    admin = _require_admin(request)
    identity = identity_connection(load_config()["identity_db_path"])
    try:
        valid_ids = {
            member["id"] for member in list_members(identity, admin["household_id"])
        }
    finally:
        identity.close()
    if not payload.user_ids or not set(payload.user_ids) <= valid_ids:
        raise HTTPException(status_code=400, detail="Owners must be household members")
    conn, _ = db
    set_account_owners(conn, household_account_id, payload.user_ids)
    return {"ok": True}


@router.put("/accounts/{household_account_id}/authoritative-source")
def promote(
    household_account_id: str,
    payload: PromoteRequest,
    env: EnvDep,
    db: DbDep,
    request: Request,
):
    _require_admin(request)
    conn, _ = db
    try:
        promote_provider_account(conn, household_account_id, payload.account_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}
