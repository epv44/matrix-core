import logging
import sqlite3
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Query, Request
from plaid.model.country_code import CountryCode
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.api.routers.auth import _require_admin
from finance.config.settings import (
    connection_token_label,
    get_token_for_connection,
    get_token_for_institution,
    token_label,
)
from finance.exceptions import ConfigError, KeychainError, PlaidError
from finance.models.dataclasses import Institution
from finance.plaid_client.auth import get_client, setup_sandbox_institution
from finance.plaid_client.investments import sync_investments
from finance.plaid_client.sync import sync_dry_run, sync_institution
from finance.security.auth import request_user
from finance.security.sanitize import sanitized_error, wrap_plaid_call
from finance.security.token_store import (
    delete_token as delete_keychain_token,
)
from finance.security.token_store import (
    get_token as get_keychain_token,
)
from finance.security.token_store import (
    set_token as set_keychain_token,
)
from finance.services.doctor import ensure_env_scoped_tokens, run_doctor
from finance.services.history import (
    history_days,
    max_history_start,
    validate_backfill_since,
)
from finance.services.institutions import unlink_connection as unlink_connection_service
from finance.services.plaid_sync import sync_all as svc_sync_all
from finance.services.reports import count_audit_history, get_audit_history
from finance.services.sync_policy import RUN, acquire_sync_scope
from finance.storage.repositories.institutions import (
    count_active_transactions,
    find_institution,
    list_transaction_accounts,
)
from finance.storage.repository import (
    count_sync_history,
    create_relink_session,
    get_all_institutions,
    get_category_rules,
    get_institution_by_uuid,
    get_last_connection_sync,
    get_relink_session,
    get_sync_history,
    get_taxonomy_mappings,
    get_type_rules,
    replace_institution_transactions,
    reset_institution_cursor,
    unique_connection_name,
    update_connection_status,
    update_relink_session,
    upsert_institution,
    upsert_type_rule,
)
from finance.storage.repository import delete_type_rule as del_rule

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["institutions"])


class LinkExchange(BaseModel):
    public_token: str
    institution: str
    relink_id: str | None = None
    connection_type: str = "DEPOSITORY"
    history_date: str | None = None
    institution_id: str | None = None
    institution_name: str | None = None


class SyncRequest(BaseModel):
    institution: str | None = None
    connection_id: str | None = None
    since: str | None = None
    replace: bool = False
    backfill: bool = False
    force: bool = False


@router.get("/institutions")
def list_institutions(env: EnvDep, db: DbDep):
    conn, _ = db

    insts = get_all_institutions(conn)
    accounts: list[dict] = []
    try:
        accounts = list_transaction_accounts(conn)
    except sqlite3.Error:
        logger.warning("Could not query transaction accounts", exc_info=True)
    return {
        "institutions": [
            {
                "id": i.id,
                "connection_id": i.connection_uuid,
                "name": i.name,
                "institution_name": i.institution_name or i.name,
                "plaid_institution_id": i.plaid_institution_id,
                "owner_user_id": i.owner_user_id,
                "plaid_item_id": i.plaid_item_id,
                "cursor": i.cursor[:20] + "..."
                if i.cursor and len(i.cursor) > 20
                else i.cursor,
                "last_successful_sync": (
                    get_last_connection_sync(conn, i.id, "INVESTMENT")
                    if i.connection_type == "INVESTMENT" and i.id is not None
                    else str(i.last_successful_sync)
                    if i.last_successful_sync
                    else None
                ),
                "last_investment_sync": (
                    get_last_connection_sync(conn, i.id, "INVESTMENT")
                    if i.id is not None
                    else None
                ),
                "connection_type": i.connection_type,
                "status": i.status,
            }
            for i in insts
        ],
        "accounts": accounts,
    }


@router.delete("/connections/{connection_id}")
def unlink_connection(connection_id: str, request: Request, env: EnvDep, db: DbDep):
    _require_admin(request)
    conn, resolved = db
    try:
        return unlink_connection_service(
            conn, get_client(resolved), resolved, connection_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PlaidError as exc:
        logger.warning(
            "Plaid unlink failed for connection %s (%s): %s",
            connection_id,
            env,
            sanitized_error(exc),
        )
        raise HTTPException(status_code=502, detail=sanitized_error(exc)) from exc
    except sqlite3.Error as exc:
        logger.exception("Local unlink cleanup failed for connection %s", connection_id)
        raise HTTPException(status_code=500, detail=sanitized_error(exc)) from exc


@router.post("/institutions/{name}/link")
def link_institution(name: str, env: EnvDep, db: DbDep, force: bool = Query(False)):
    conn, resolved = db

    client = get_client(resolved)
    label = token_label(env, name)
    existing = get_keychain_token(label)
    if existing and not force:
        raise HTTPException(
            status_code=400, detail=f"Token exists for {name} ({env}). Use force"
        )
    if env == "sandbox":
        _, item_id = setup_sandbox_institution(client, name, resolved)
        upsert_institution(conn, Institution(name=name, plaid_item_id=item_id))
        reset_institution_cursor(conn, name)
        return {"ok": True, "institution": name, "env": env, "item_id": item_id}
    raise HTTPException(
        status_code=400,
        detail="Production link requires frontend Plaid Link flow: POST /api/link/token then /api/link/exchange",
    )


@router.post("/institutions/{name}/relink/start")
def relink_institution(
    name: str,
    env: EnvDep,
    db: DbDep,
    history_date: str | None = Query(None),
):
    conn, resolved = db
    if env != "production":
        raise HTTPException(
            status_code=400,
            detail="Relink is for production items; for sandbox use POST /institutions/{name}/link?force=true",
        )
    institution = find_institution(conn, name)
    connection_type = institution.connection_type if institution else "DEPOSITORY"
    try:
        client, history_start, days = _prepare_relink(
            institution, name, env, resolved, history_date, connection_type
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except (PlaidError, KeychainError) as exc:
        safe = sanitized_error(exc)
        logger.warning("Relink setup failed for %s (%s): %s", name, env, safe)
        raise HTTPException(status_code=500, detail=safe)

    try:
        if connection_type == "INVESTMENT":
            return _backfill_existing_investment(
                conn, client, name, env, resolved, history_start
            )
        return _create_relink_token(
            conn, client, name, env, resolved, history_start, days
        )
    except (PlaidError, KeychainError, sqlite3.Error) as exc:
        safe = sanitized_error(exc)
        logger.warning("Relink token creation failed for %s (%s): %s", name, env, safe)
        raise HTTPException(status_code=500, detail=safe)


@router.post("/connections/{connection_id}/relink/start")
def relink_connection(
    connection_id: str,
    env: EnvDep,
    db: DbDep,
    history_date: str | None = Query(None),
):
    conn, _ = db
    institution = get_institution_by_uuid(conn, connection_id)
    if institution is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return relink_institution(institution.name, env, db, history_date)


def _prepare_relink(
    institution, name, env, resolved, history_date, connection_type="DEPOSITORY"
):

    client = get_client(resolved)
    if institution is None or _connection_token(institution, resolved) is None:
        raise HTTPException(
            status_code=400,
            detail=f"No access token for {name} ({env}) — link it first",
        )
    history_start = date.fromisoformat(history_date) if history_date else None
    days = history_days(history_start)
    if (
        connection_type == "DEPOSITORY"
        and days > 30
        and not resolved.get("webhook_url")
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Backfills beyond 30 days require a configured webhook; "
                "the requested history window was not changed"
            ),
        )
    logger.info(
        "Backfill authorization requested for %s (%s): history_date=%s days_requested=%d",
        name,
        env,
        (history_start or max_history_start()).isoformat(),
        days,
    )
    return client, history_start, days


def _backfill_existing_investment(conn, client, name, env, resolved, history_start):
    """Backfill an investment Item in place; never remove or replace its Item."""

    institution = find_institution(conn, name)
    if institution is None:
        raise HTTPException(status_code=400, detail="Connection not found")
    token = get_keychain_token(_connection_label(env, institution))
    if token is None:
        token = get_token_for_institution(resolved, name)
    stats = sync_investments(
        client,
        conn,
        name,
        token,
        since=history_start,
        item_id=institution.plaid_item_id if institution else None,
    )
    logger.info(
        "Investment backfill complete for %s (%s): history_date=%s",
        name,
        env,
        history_start.isoformat() if history_start else "default-30-days",
    )
    return {
        "ok": True,
        "direct": True,
        "relink": False,
        "institution": name,
        "env": env,
        "connection_type": "INVESTMENT",
        "initial_sync": stats,
    }


def _create_relink_token(conn, client, name, env, resolved, history_start, days):

    link_kwargs: dict = {
        "user": LinkTokenCreateRequestUser(client_user_id=str(uuid.uuid4())),
        "client_name": "Budget App",
        "products": [Products("transactions")],
        "country_codes": [CountryCode("US")],
        "language": "en",
        "transactions": LinkTokenTransactions(days_requested=days),
    }
    if resolved.get("webhook_url"):
        link_kwargs["webhook"] = resolved["webhook_url"]
    if resolved.get("plaid_redirect_uri"):
        link_kwargs["redirect_uri"] = resolved["plaid_redirect_uri"]
    response = wrap_plaid_call(
        lambda: client.link_token_create(LinkTokenCreateRequest(**link_kwargs))
    )
    institution_id = upsert_institution(conn, Institution(name=name))
    relink_id = str(uuid.uuid4())
    history_value = (history_start or max_history_start()).isoformat()
    create_relink_session(conn, relink_id, env, institution_id, history_value, days)
    logger.info(
        "Backfill authorization prepared for %s (%s): relink_id=%s history_date=%s days_requested=%d",
        name,
        env,
        relink_id,
        history_value,
        days,
    )
    return {
        "link_token": response["link_token"],
        "relink_id": relink_id,
        "institution": name,
        "env": env,
        "relink": True,
    }


@router.post("/institutions/{name}/relink/recover")
def recover_relink(name: str, env: EnvDep, db: DbDep, relink_id: str = Query(...)):
    conn, _ = db

    session = get_relink_session(conn, relink_id)
    institution = find_institution(conn, name)
    if (
        session is None
        or session["env"] != env
        or institution is None
        or session["institution_id"] != institution.id
        or session["status"] not in ("old_removed", "recovery")
        or not session["pending_token_label"]
        or not session["new_item_id"]
    ):
        raise HTTPException(status_code=400, detail="Relink is not recoverable")
    pending_token = get_keychain_token(session["pending_token_label"])
    if pending_token is None:
        raise HTTPException(
            status_code=500, detail="Staged replacement token is missing"
        )
    try:
        set_keychain_token(token_label(env, name), pending_token)
        replace_institution_transactions(conn, name)
        upsert_institution(
            conn, Institution(name=name, plaid_item_id=session["new_item_id"])
        )
        reset_institution_cursor(conn, name)
        update_relink_session(conn, relink_id, status="complete", error=None)
        delete_keychain_token(session["pending_token_label"])
        return {"ok": True, "institution": name, "relink_id": relink_id}
    except (KeychainError, sqlite3.Error) as exc:
        safe = sanitized_error(exc)
        update_relink_session(conn, relink_id, status="recovery", error=safe)
        raise HTTPException(status_code=500, detail=safe)


@router.post("/link/token")
def create_link_token(
    env: EnvDep,
    db: DbDep,
    institution: str = Query(..., description="institution name"),
    history_date: str | None = Query(
        None,
        description="fetch transaction history back to YYYY-MM-DD (max 24 months); default 24 months",
    ),
    connection_type: str = Query("DEPOSITORY", pattern="^(DEPOSITORY|INVESTMENT)$"),
    *,
    request: Request,
):
    _, resolved = db
    days = _link_history_days(history_date)
    try:
        webhook_url = resolved.get("webhook_url")
        if not webhook_url:
            days = min(days, 30)
        client = get_client(resolved)
        user = request_user(request)
        user_id = user["plaid_client_user_id"] if user else str(uuid.uuid4())
        link_kwargs = _link_token_kwargs(
            user_id,
            connection_type,
            days,
            webhook_url,
            resolved.get("plaid_redirect_uri"),
        )
        logger.info(
            "Creating %s link token for %s (%s): days_requested=%d webhook=%s",
            connection_type,
            institution,
            env,
            days,
            bool(webhook_url),
        )
        req = LinkTokenCreateRequest(**link_kwargs)
        resp = wrap_plaid_call(lambda: client.link_token_create(req))
        return {
            "link_token": resp["link_token"],
            "institution": institution,
            "env": env,
            "connection_type": connection_type,
        }
    except (PlaidError, KeychainError) as exc:
        safe = sanitized_error(exc)
        logger.warning(
            "Link token creation failed for %s (%s): %s", institution, env, safe
        )
        raise HTTPException(status_code=500, detail=safe)


def _link_history_days(history_date: str | None) -> int:
    try:
        parsed = date.fromisoformat(history_date) if history_date else None
    except ValueError:
        raise HTTPException(status_code=400, detail="history_date must be YYYY-MM-DD")
    try:
        return history_days(parsed)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _link_token_kwargs(
    user_id: str,
    connection_type: str,
    days: int,
    webhook_url: str | None,
    redirect_uri: str | None,
) -> dict:
    kwargs: dict = {
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
        "client_name": "Budget App",
        "products": [
            Products(
                "investments" if connection_type == "INVESTMENT" else "transactions"
            )
        ],
        "country_codes": [CountryCode("US")],
        "language": "en",
    }
    if redirect_uri:
        kwargs["redirect_uri"] = redirect_uri
    if connection_type != "INVESTMENT":
        kwargs["transactions"] = LinkTokenTransactions(days_requested=days)
    if webhook_url:
        kwargs["webhook"] = webhook_url
    return kwargs


@router.post("/link/exchange")
def exchange_link_token(
    payload: LinkExchange, request: Request, env: EnvDep, db: DbDep
):
    conn, resolved = db

    client = None
    access_token = None
    item_id = None
    pending_label = None
    old_removed = False
    try:
        client = get_client(resolved)
        req = ItemPublicTokenExchangeRequest(public_token=payload.public_token)
        resp = wrap_plaid_call(lambda: client.item_public_token_exchange(req))
        access_token = resp["access_token"]
        item_id = resp["item_id"]
        user = request_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        connection_name, connection_uuid, pending_label, old_removed = (
            _store_exchanged_connection(
                conn, client, payload, env, user, access_token, item_id
            )
        )
        reset_institution_cursor(conn, connection_name)
        logger.info(
            "Public token exchanged for %s (%s): item_id=%s",
            connection_name,
            env,
            item_id,
        )
        initial_sync = _initial_exchange_sync(
            client, conn, payload, connection_name, env, access_token, resolved
        )
        if not payload.relink_id:
            assert connection_uuid is not None
            update_connection_status(
                conn,
                connection_uuid,
                "COMPLETE" if initial_sync.get("ok") else "SYNC_ERROR",
            )
            pending_label = None
        return {
            "ok": True,
            "institution": connection_name,
            "connection_id": connection_uuid if not payload.relink_id else None,
            "item_id": item_id,
            "env": env,
            "relink": bool(payload.relink_id),
            "initial_sync": initial_sync,
        }
    except HTTPException:
        _remove_rejected_item(client, access_token)
        raise
    except (PlaidError, KeychainError, sqlite3.Error) as exc:
        safe = sanitized_error(exc)
        _record_exchange_failure(conn, payload.relink_id, old_removed, exc)
        _cleanup_exchange(client, access_token, pending_label, old_removed)
        logger.warning(
            "Token exchange failed for %s (%s): %s",
            payload.institution,
            env,
            safe,
        )
        raise HTTPException(status_code=500, detail=safe)


def _store_exchanged_connection(
    conn, client, payload, env, user, access_token, item_id
) -> tuple[str, str | None, str | None, bool]:
    if payload.relink_id:
        existing = find_institution(conn, payload.institution)
        if existing is None:
            raise HTTPException(status_code=400, detail="Connection not found")
        pending = _activate_relink(
            conn,
            client,
            payload,
            env,
            _connection_label(env, existing),
            access_token,
            item_id,
        )
        return payload.institution, None, pending, True

    connection_name = unique_connection_name(
        conn,
        payload.institution_name or payload.institution,
        user.get("username"),
    )
    connection_uuid = str(uuid.uuid4())
    label = connection_token_label(env, connection_uuid)
    set_keychain_token(label, access_token)
    upsert_institution(
        conn,
        Institution(
            name=connection_name,
            plaid_item_id=item_id,
            connection_type=payload.connection_type,
            connection_uuid=connection_uuid,
            institution_name=payload.institution_name or payload.institution,
            plaid_institution_id=payload.institution_id,
            household_id=user["household_id"],
            owner_user_id=user["id"],
            status="SYNCING",
        ),
    )
    return connection_name, connection_uuid, label, False


def _activate_relink(conn, client, payload, env, label, access_token, item_id):

    session = get_relink_session(conn, payload.relink_id)
    institution = find_institution(conn, payload.institution)
    _validate_relink_session(session, institution, payload.relink_id, env)
    logger.info(
        "Backfill exchange started for %s (%s): relink_id=%s history_date=%s days_requested=%s",
        payload.institution,
        env,
        payload.relink_id,
        session["history_date"],
        session["days_requested"],
    )
    old_token = get_keychain_token(label)
    if old_token is None:
        raise HTTPException(status_code=400, detail="Original token is missing")
    pending_label = f"{label}_relink_{payload.relink_id}"
    set_keychain_token(pending_label, access_token)
    update_relink_session(
        conn,
        payload.relink_id,
        status="staged",
        pending_token_label=pending_label,
        new_item_id=item_id,
    )
    wrap_plaid_call(
        lambda: client.item_remove(ItemRemoveRequest(access_token=old_token))
    )
    update_relink_session(conn, payload.relink_id, status="old_removed")
    set_keychain_token(label, access_token)
    replace_institution_transactions(conn, payload.institution)
    upsert_institution(
        conn, Institution(name=payload.institution, plaid_item_id=item_id)
    )
    reset_institution_cursor(conn, payload.institution)
    update_relink_session(conn, payload.relink_id, status="complete", error=None)
    delete_keychain_token(pending_label)
    logger.info(
        "Backfill authorization exchanged for %s (%s): relink_id=%s",
        payload.institution,
        env,
        payload.relink_id,
    )
    return pending_label


def _connection_label(env: str, institution: Institution) -> str:
    if institution.connection_uuid:
        return connection_token_label(env, institution.connection_uuid)
    return token_label(env, institution.name)


def _connection_token(institution: Institution, resolved: dict) -> str | None:
    token = get_keychain_token(
        _connection_label(resolved["plaid_environment"], institution)
    )
    if token is not None:
        return token
    try:
        return get_token_for_connection(resolved, institution)
    except ConfigError:
        return None


def _validate_relink_session(session, institution, relink_id, env) -> None:
    valid = (
        session is not None
        and session["env"] == env
        and institution is not None
        and session["institution_id"] == institution.id
        and session["status"] in ("pending", "recovery")
    )
    if not valid or relink_id is None:
        raise HTTPException(status_code=400, detail="Invalid relink session")


def _initial_exchange_sync(
    client, conn, payload, connection_name, env, access_token, resolved
):
    if payload.connection_type == "INVESTMENT":
        try:
            institution = find_institution(conn, connection_name)
            return {
                "ok": True,
                **sync_investments(
                    client,
                    conn,
                    connection_name,
                    access_token,
                    since=(
                        date.fromisoformat(payload.history_date)
                        if payload.history_date
                        else None
                    ),
                    item_id=institution.plaid_item_id if institution else None,
                ),
            }
        except PlaidError as exc:
            safe = sanitized_error(exc)
            logger.warning(
                "Investment data is still loading for %s: %s", connection_name, safe
            )
            return {
                "ok": True,
                "status": "WAITING_FOR_INVESTMENT_DATA",
                "error": safe,
            }
        except (sqlite3.Error, ValueError) as exc:
            safe = sanitized_error(exc)
            logger.warning(
                "Investment initial sync failed for %s: %s", connection_name, safe
            )
            return {"ok": False, "status": "SYNC_ERROR", "error": safe}

    try:
        stats = sync_institution(client, conn, connection_name, access_token, resolved)
        if payload.relink_id:
            logger.info(
                "Backfill initial sync complete for %s (%s): relink_id=%s added=%d modified=%d removed=%d",
                connection_name,
                env,
                payload.relink_id,
                stats["added"],
                stats["modified"],
                stats["removed"],
            )
        return {"ok": True, **stats}
    except (PlaidError, ConfigError, KeychainError, sqlite3.Error) as exc:
        safe = sanitized_error(exc)
        logger.warning(
            "Initial sync failed after exchange for %s (%s): %s",
            connection_name,
            env,
            safe,
        )
        return {"ok": False, "error": safe}


def _remove_rejected_item(client, access_token) -> None:
    if client is None or access_token is None:
        return

    try:
        wrap_plaid_call(
            lambda: client.item_remove(ItemRemoveRequest(access_token=access_token))
        )
    except PlaidError as exc:
        logger.error(
            "Could not remove rejected replacement item: %s", sanitized_error(exc)
        )


def _record_exchange_failure(conn, relink_id, old_removed, exc) -> None:
    if not relink_id:
        return

    try:
        update_relink_session(
            conn,
            relink_id,
            status="recovery" if old_removed else "failed",
            error=sanitized_error(exc),
        )
    except sqlite3.Error:
        logger.exception("Could not record relink failure")


def _cleanup_exchange(client, access_token, pending_label, old_removed) -> None:
    if old_removed or client is None or access_token is None:
        return

    try:
        _remove_rejected_item(client, access_token)
        if pending_label:
            delete_keychain_token(pending_label)
    except KeychainError:
        logger.exception("Could not clean up replacement item")


@router.post("/sync")
def sync_all(env: EnvDep, db: DbDep, req: Annotated[SyncRequest, Body()]):
    conn, resolved = db
    institution_filter = _sync_institution_filter(conn, req)
    since = _sync_start_date(req.since)
    _validate_sync_backfill(req, since)
    scope_names: tuple[str, ...]
    if institution_filter:
        scope_names = (institution_filter,)
    else:
        scope_names = tuple(i.name for i in get_all_institutions(conn))
    with acquire_sync_scope(conn, names=scope_names, force=req.force) as status:
        if status != RUN:
            return {"status": status, "results": {}}
        client = get_client(resolved)
        results = svc_sync_all(
            conn,
            client,
            resolved,
            since=since,
            institution_filter=institution_filter,
            replace=req.replace,
            backfill=req.backfill,
        )
        return {"status": "completed", "results": results}


def _sync_institution_filter(conn, req: SyncRequest) -> str | None:
    if req.institution and req.connection_id:
        raise HTTPException(
            status_code=400,
            detail="institution and connection_id are mutually exclusive",
        )
    if not req.connection_id:
        return req.institution
    institution = get_institution_by_uuid(conn, req.connection_id)
    if institution is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return institution.name


def _sync_start_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="since must be YYYY-MM-DD")


def _validate_sync_backfill(req: SyncRequest, since: date | None) -> None:
    if not req.backfill:
        return
    if req.replace:
        raise HTTPException(
            status_code=400, detail="backfill and replace are mutually exclusive"
        )
    if since is None:
        raise HTTPException(
            status_code=400, detail="backfill requires since (YYYY-MM-DD)"
        )
    try:
        validate_backfill_since(since)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/sync/history")
def sync_history(
    env: EnvDep,
    db: DbDep,
    limit: int = Query(20, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    conn, _ = db

    return {
        "history": get_sync_history(conn, env, limit=limit, offset=offset),
        "total": count_sync_history(conn, env),
        "limit": limit,
        "offset": offset,
    }


@router.post("/sync/dry-run")
def dry_run(
    env: EnvDep, db: DbDep, institution: str = Query(...), since: str | None = None
):
    conn, resolved = db

    since_d = None
    if since:
        try:
            since_d = date.fromisoformat(since)
        except ValueError:
            raise HTTPException(status_code=400, detail="since must be YYYY-MM-DD")
    if since_d is not None:
        try:
            validate_backfill_since(since_d)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    client = get_client(resolved)
    try:
        token = get_token_for_institution(resolved, institution)
    except ConfigError:
        if env == "sandbox":
            token, _ = setup_sandbox_institution(client, institution, resolved)
        else:
            raise HTTPException(status_code=400, detail=f"No token for {institution}")
    mappings = get_taxonomy_mappings(conn)
    category_rules = get_category_rules(conn)
    months = sync_dry_run(
        client,
        token,
        since=since_d,
        institution_name=institution,
        mappings=mappings,
        category_rules=category_rules,
    )
    summary = {f"{y}-{m:02d}": len(v) for (y, m), v in months.items()}
    return {"months": summary, "total": sum(len(v) for v in months.values())}


@router.get("/doctor")
def doctor(env: EnvDep, db: DbDep):
    _, resolved = db

    return {"checks": run_doctor(resolved)}


@router.post("/doctor/fix")
def doctor_fix(env: EnvDep, db: DbDep):
    _, resolved = db

    return {"rekeyed": ensure_env_scoped_tokens(resolved)}


@router.post("/categorize/recalculate")
def recalc(env: EnvDep, db: DbDep):
    conn, _ = db
    count = count_active_transactions(conn)
    return {"categories_resolve_on_read": True, "transaction_count": count}


class TypeRuleRequest(BaseModel):
    pattern: str
    transaction_type: str
    match_type: str = "BOTH"


@router.get("/type-rules")
def list_type_rules(env: EnvDep, db: DbDep):
    conn, _ = db

    rules = get_type_rules(conn)
    return {
        "rules": [
            {
                "id": r.id,
                "pattern": r.pattern,
                "match_type": r.match_type,
                "transaction_type": r.transaction_type,
                "priority": r.priority,
                "source": r.source,
                "enabled": r.enabled,
                "created_at": str(r.created_at) if r.created_at else None,
            }
            for r in rules
        ]
    }


@router.post("/type-rules")
def create_type_rule(req: TypeRuleRequest, env: EnvDep, db: DbDep):
    conn, _ = db

    txn_type = req.transaction_type.strip().upper()
    if txn_type not in ("INCOME", "TRANSFER", "EXPENSE"):
        raise HTTPException(
            status_code=400,
            detail="transaction_type must be INCOME, TRANSFER, or EXPENSE",
        )
    pattern = req.pattern.strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="pattern required")
    if req.match_type not in (
        "MERCHANT",
        "DESCRIPTION",
        "BOTH",
        "REGEX",
        "PREFIX",
        "EXACT",
    ):
        raise HTTPException(status_code=400, detail="Invalid match_type")
    upsert_type_rule(conn, pattern, txn_type, match_type=req.match_type)
    return {
        "ok": True,
        "pattern": pattern,
        "transaction_type": txn_type,
        "match_type": req.match_type,
    }


@router.delete("/type-rules/{rule_id}")
def delete_type_rule(rule_id: int, env: EnvDep, db: DbDep):
    conn, _ = db

    del_rule(conn, rule_id)
    return {"ok": True, "rule_id": rule_id}


@router.get("/audit")
def audit(
    env: EnvDep,
    db: DbDep,
    txn_id: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    conn, _ = db

    changes = get_audit_history(conn, txn_id=txn_id, limit=limit, offset=offset)
    total = count_audit_history(conn, txn_id=txn_id)
    return {
        "changes": [
            {
                "transaction_id": c.transaction_id,
                "old_category": c.old_category,
                "new_category": c.new_category,
                "reason": c.reason,
                "timestamp": str(c.timestamp),
            }
            for c in changes
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }
