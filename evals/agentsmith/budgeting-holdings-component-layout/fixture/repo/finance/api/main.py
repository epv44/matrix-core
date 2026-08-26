import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from finance.api.routers import (
    auth,
    categories,
    dashboard,
    export,
    financial_tools,
    households,
    income,
    institutions,
    settings,
    transactions,
    webhook,
)
from finance.config.logging_config import setup_logging
from finance.config.settings import VALID_ENVIRONMENTS, load_config, resolve_environment
from finance.exceptions import ConfigError
from finance.security.auth import (
    PUBLIC_PATHS,
    SAFE_METHODS,
    authenticate_request,
    csrf_matches,
)
from finance.services.webhook_jobs import worker
from finance.storage.identity import initialize_identity_database
from finance.storage.schema import initialize_database

try:
    setup_logging(load_config())
except (OSError, ConfigError) as exc:
    logging.getLogger(__name__).warning("Logging setup failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):

    config = load_config()
    identity_db_path = config.get("identity_db_path")
    if identity_db_path:
        initialize_identity_database(identity_db_path)
    for environment in VALID_ENVIRONMENTS:
        try:
            resolved = resolve_environment(config, environment)
        except ConfigError as exc:
            logging.getLogger(__name__).debug(
                "Skipping database initialization for %s: %s", environment, exc
            )
            continue
        initialize_database(resolved["db_path"], check_same_thread=False)

    worker.start()
    try:
        yield
    finally:
        worker.stop()


app = FastAPI(
    title="Budget App API",
    version="1.0.0",
    description="FastAPI service for the React frontend",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_household_session(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
        return await call_next(request)
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    user = authenticate_request(request)
    if user is None:
        return JSONResponse(
            status_code=401, content={"detail": "Authentication required"}
        )
    request.state.user = user
    if user.get("must_change_password") and request.url.path not in {
        "/api/auth/me",
        "/api/auth/logout",
        "/api/auth/password",
    }:
        return JSONResponse(
            status_code=403,
            content={"detail": "Password change required"},
        )
    if request.method not in SAFE_METHODS and not csrf_matches(request, user):
        return JSONResponse(status_code=403, content={"detail": "Invalid CSRF token"})
    return await call_next(request)


app.include_router(dashboard.router)
app.include_router(auth.router)
app.include_router(households.router)
app.include_router(transactions.router)
app.include_router(income.router)
app.include_router(categories.router)
app.include_router(institutions.router)
app.include_router(webhook.router)
app.include_router(export.router)
app.include_router(financial_tools.router)
app.include_router(settings.router)


@app.get("/health")
def health():
    return {"ok": True}
