import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

logger = logging.getLogger(__name__)

UPSTREAM_BASE_URL = "http://127.0.0.1:3000"
UPSTREAM_HOST = "127.0.0.1:3000"
LAN_PROXY_PORT = 3443

_HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

_RESPONSE_STRIPPED_HEADERS = _HOP_BY_HOP_HEADERS | {"content-encoding"}


def _forwarded_request_headers(headers) -> dict[str, str]:
    forwarded = {
        name: value
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP_HEADERS
    }
    forwarded["Host"] = UPSTREAM_HOST
    return forwarded


def _upstream_response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.multi_items()
        if name.lower() not in _RESPONSE_STRIPPED_HEADERS
    }


async def _proxy(request: Request) -> Response:
    client: httpx.AsyncClient = request.app.state.proxy_client
    path = request.url.path
    if request.url.query:
        path = f"{path}?{request.url.query}"
    body = await request.body()
    try:
        upstream = await client.request(
            request.method,
            path,
            content=body,
            headers=_forwarded_request_headers(request.headers),
        )
    except httpx.HTTPError as exc:
        logger.warning("LAN proxy upstream request failed: %s", exc)
        return Response(status_code=502, content="Upstream service unavailable")
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_upstream_response_headers(upstream.headers),
    )


@asynccontextmanager
async def _lifespan(app: Starlette) -> AsyncIterator[None]:
    async with httpx.AsyncClient(base_url=UPSTREAM_BASE_URL) as client:
        app.state.proxy_client = client
        yield


app = Starlette(
    lifespan=_lifespan,
    routes=[
        Route(
            "/{path:path}",
            _proxy,
            methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        )
    ],
)
