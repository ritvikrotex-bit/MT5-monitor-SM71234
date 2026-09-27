"""MT5 Connector — the only process that loads MT5APIManager64.dll.

All routes require header X-Connector-Secret. Read-only operations only.
"""
from __future__ import annotations

import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from connector.config import settings
from connector.errors import AccountNotFound, BrokerUnavailable, ConnectorError, InvalidCredentials
from connector.providers.factory import get_provider
from connector.schemas import (
    AccountRequest,
    AccountResponse,
    Credentials,
    PositionsResponse,
    SearchRequest,
    SearchResponse,
    SessionRequest,
    SymbolsResponse,
    StatusResponse,
    TestResponse,
)

app = FastAPI(title="MT5 Client Live Monitor Connector", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Connector-Secret"],
    allow_origin_regex=r"http://127\.0\.0\.1:\d+",
)


def require_secret(x_connector_secret: str = Header(default="")) -> None:
    if not secrets.compare_digest(x_connector_secret.encode(), settings.connector_secret.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad connector secret")


def _http_for(exc: Exception) -> JSONResponse:
    if isinstance(exc, InvalidCredentials):
        return JSONResponse(status_code=401, content={"error": exc.code, "message": str(exc)})
    if isinstance(exc, AccountNotFound):
        return JSONResponse(status_code=404, content={"error": exc.code, "message": str(exc)})
    if isinstance(exc, BrokerUnavailable):
        return JSONResponse(status_code=503, content={"error": exc.code, "message": str(exc)})
    if isinstance(exc, ConnectorError):
        code = 503 if exc.code in {"CONNECTOR_UNAVAILABLE", "BROKER_UNAVAILABLE"} else 502
        return JSONResponse(status_code=code, content={"error": exc.code, "message": str(exc)})
    return JSONResponse(
        status_code=502,
        content={"error": "CONNECTOR_ERROR", "message": str(exc)},
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "real"}


@app.post("/v1/test", response_model=TestResponse, dependencies=[Depends(require_secret)])
def test(creds: Credentials):
    provider = get_provider()
    try:
        ok, message = provider.test(creds)
        st, _ = provider.status(creds)
        return TestResponse(ok=ok, message=message, mode=provider.mode, status=st)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/session/connect", response_model=StatusResponse, dependencies=[Depends(require_secret)])
def connect(req: SessionRequest):
    provider = get_provider()
    try:
        st, message = provider.connect(req)
        return StatusResponse(status=st, message=message, mode=provider.mode)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/session/disconnect", response_model=StatusResponse, dependencies=[Depends(require_secret)])
def disconnect(req: SessionRequest):
    provider = get_provider()
    try:
        st, message = provider.disconnect(req)
        return StatusResponse(status=st, message=message, mode=provider.mode)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/session/status", response_model=StatusResponse, dependencies=[Depends(require_secret)])
def session_status(req: SessionRequest):
    provider = get_provider()
    st, message = provider.status(req)
    return StatusResponse(status=st, message=message, mode=provider.mode)


@app.post("/v1/symbols", response_model=SymbolsResponse, dependencies=[Depends(require_secret)])
def list_symbols(creds: Credentials):
    """Symbol names configured on this server, for copier translation previews."""
    provider = get_provider()
    try:
        return provider.list_symbols(creds)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/clients/search", response_model=SearchResponse, dependencies=[Depends(require_secret)])
def search(req: SearchRequest):
    provider = get_provider()
    try:
        return provider.search(req, req.query, req.by)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/clients/get", response_model=AccountResponse, dependencies=[Depends(require_secret)])
def get_account(req: AccountRequest):
    provider = get_provider()
    try:
        return provider.get_account(req, req.account)
    except Exception as exc:
        return _http_for(exc)


@app.post("/v1/clients/positions", response_model=PositionsResponse, dependencies=[Depends(require_secret)])
def get_positions(req: AccountRequest):
    provider = get_provider()
    try:
        return provider.get_positions(req, req.account)
    except Exception as exc:
        return _http_for(exc)
