"""HTTP face of the copier service.

The web app stays the source of truth for configuration: it decrypts the stored
account passwords and pushes the whole desired state here with PUT /v1/config,
at boot and after every edit. This service keeps only runtime state (which
destination position mirrors which master one) on disk.

Every route except /health requires the X-Copier-Secret header.
"""
from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from copier.config import settings
from copier.engine import Engine, Link
from copier.sources import TerminalMaster
from copier.pool import Account, CommandFailed, Pool, WorkerDown
from copier.sources import ConnectorClient, MasterReader
from copier.state import StateStore

log = logging.getLogger("copier.main")

pool = Pool(settings.terminals_root)
state = StateStore(settings.state_dir / "copier-state.json")
masters = MasterReader(
    ConnectorClient(settings.connector_url, settings.connector_secret)
    if settings.connector_secret
    else None,
    pool,
)
engine = Engine(
    pool,
    state,
    masters,
    poll_interval=settings.poll_interval,
    snapshot_timeout=settings.snapshot_timeout,
    order_timeout=settings.order_timeout,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    engine.start()
    yield
    engine.stop()
    pool.stop_all()


app = FastAPI(title="MT5 Trade Copier", version="1.0.0", lifespan=lifespan)


def require_secret(x_copier_secret: str = Header(default="")) -> None:
    if not secrets.compare_digest(x_copier_secret.encode(), settings.copier_secret.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad copier secret")


class AccountIn(BaseModel):
    id: str
    label: str = ""
    server: str
    login: int
    password: str


class ConfigIn(BaseModel):
    accounts: list[AccountIn] = Field(default_factory=list)
    """Destination accounts. Masters are read over the Manager API and need no
    terminal, so they do not appear here."""

    links: list[dict[str, Any]] = Field(default_factory=list)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "mt5-copier"}


@app.put("/v1/config", dependencies=[Depends(require_secret)])
def put_config(body: ConfigIn) -> dict[str, Any]:
    """Replace the whole configuration.

    Accounts that disappear have their workers stopped; links that disappear
    stop being reconciled but keep their state file entry, so re-adding one
    does not re-copy trades it already owns.
    """
    accounts = [
        Account(
            id=a.id, label=a.label or f"{a.server}/{a.login}",
            server=a.server, login=a.login, password=a.password,
        )
        for a in body.accounts
    ]
    known = {a.id for a in accounts}
    links: list[Link] = []
    problems: list[str] = []
    for raw in body.links:
        try:
            link = Link.from_dict(raw)
        except (KeyError, TypeError, ValueError) as exc:
            problems.append(f"link {raw.get('id', '?')}: {exc}")
            continue
        if link.dest_id not in known:
            problems.append(f"link {link.id}: unknown destination account {link.dest_id}")
            continue
        master = link.master
        if isinstance(master, TerminalMaster):
            if master.account_id not in known:
                problems.append(f"link {link.id}: unknown master account {master.account_id}")
                continue
            if master.account_id == link.dest_id:
                problems.append(f"link {link.id}: an account cannot copy onto itself")
                continue
        links.append(link)

    pool.set_accounts(accounts)
    engine.set_links(links)
    log.info("config: %d account(s), %d link(s), %d rejected", len(accounts), len(links), len(problems))
    return {"accounts": len(accounts), "links": len(links), "problems": problems}


@app.get("/v1/status", dependencies=[Depends(require_secret)])
def get_status() -> dict[str, Any]:
    return engine.status()


@app.get("/v1/events", dependencies=[Depends(require_secret)])
def get_events(limit: int = 100) -> dict[str, Any]:
    return {"events": engine.events(min(max(limit, 1), 500))}


@app.post("/v1/accounts/{account_id}/probe", dependencies=[Depends(require_secret)])
def probe(account_id: str) -> dict[str, Any]:
    """Log in and report what the account looks like, without trading."""
    try:
        return pool.get(account_id).call("snapshot", timeout=settings.snapshot_timeout)
    except WorkerDown as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CommandFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/v1/accounts/{account_id}/symbols", dependencies=[Depends(require_secret)])
def symbols(account_id: str, q: str = "") -> dict[str, Any]:
    """List the symbols this account can trade, so a mapping can be checked
    against what the broker really offers rather than guessed at."""
    try:
        result = pool.get(account_id).call("symbols", timeout=settings.snapshot_timeout)
    except WorkerDown as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CommandFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    names = result.get("symbols") or []
    if q:
        needle = q.strip().upper()
        names = [n for n in names if needle in n.upper()]
    return {"symbols": sorted(names), "total": len(names)}


@app.post("/v1/links/{link_id}/arm", dependencies=[Depends(require_secret)])
def arm(link_id: str) -> dict[str, Any]:
    """Clear a halt so a stopped link can run again."""
    if link_id not in engine.links:
        raise HTTPException(status_code=404, detail="unknown link")
    engine.arm(link_id)
    return {"ok": True}


@app.post("/v1/links/{link_id}/flatten", dependencies=[Depends(require_secret)])
def flatten(link_id: str) -> dict[str, Any]:
    """Close every destination position this link owns. The master is untouched."""
    link = engine.links.get(link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="unknown link")
    link_state = state.get(link_id)
    before = len(link_state.mapping)
    engine._flatten(link, link_state, reason="manual")
    return {"ok": True, "closed": before - len(link_state.mapping), "remaining": len(link_state.mapping)}
