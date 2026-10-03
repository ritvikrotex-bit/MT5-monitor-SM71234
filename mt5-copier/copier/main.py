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
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from copier.config import settings
from copier.engine import Engine, Link
from copier.pool import Account, CommandFailed, Pool, WorkerDown
from copier.rules import SymbolIndex, preview_translation
from copier.sources import (
    ConnectorClient,
    MasterReader,
    SourceUnavailable,
    TerminalMaster,
    manager_symbols,
)
from copier.journal import Journal
from copier.state import StateStore
from copier.testrun import run_test

log = logging.getLogger("copier.main")

# Identifies this run of the service; see /v1/events.
BOOT_ID = uuid.uuid4().hex

pool = Pool(settings.terminals_root)
state = StateStore(settings.state_dir / "copier-state.json")
journal = Journal(settings.state_dir / "journal.jsonl")
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
    journal=journal,
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
def get_events(limit: int = 100, since: int = -1) -> dict[str, Any]:
    """Recent decisions. With ``since`` it returns only what follows that
    cursor, oldest first, so an alerter cannot miss or repeat one. Omit it to
    read the feed newest first."""
    events = engine.events(min(max(limit, 1), 500), since=since)
    # The cursor starts again at zero when this process restarts. The boot id
    # lets a follower see that happen and read everything since, instead of
    # mistaking the new, lower numbers for events it has already handled.
    return {"events": events, "cursor": engine.sequence, "boot": BOOT_ID}


@app.get("/v1/journal", dependencies=[Depends(require_secret)])
def get_journal(links: str = "", since: float = 0.0, limit: int = 500) -> dict[str, Any]:
    """Copies, newest first, each with its open and close: prices, slippage,
    latency and result. ``links`` is a comma-separated list of link ids to
    include; the web app passes the ones the caller owns."""
    wanted = {link_id for link_id in links.split(",") if link_id} if links else None
    return {"trades": journal.trades(link_ids=wanted, since=since, limit=min(max(limit, 1), 5000))}


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


@app.get("/v1/accounts/{account_id}/symbols/{symbol}", dependencies=[Depends(require_secret)])
def symbol_spec(account_id: str, symbol: str) -> dict[str, Any]:
    """Ask the terminal about one symbol directly.

    This is authoritative where the cached symbol list is not: it selects the
    symbol in Market Watch first, so it finds instruments the broker offers but
    the terminal had not pulled into its local list yet.
    """
    try:
        return pool.get(account_id).call(
            "spec", {"symbol": symbol}, timeout=settings.snapshot_timeout
        )
    except WorkerDown as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CommandFailed as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/v1/links/{link_id}/preview", dependencies=[Depends(require_secret)])
def preview(link_id: str, q: str = "", limit: int = 400) -> dict[str, Any]:
    """How this link would translate every symbol the master could trade.

    The counts cover the master's whole symbol list; the rows are capped so a
    server with thousands of instruments does not have to be sent in full.
    """
    link = engine.links.get(link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="unknown link")

    try:
        if isinstance(link.master, TerminalMaster):
            source_symbols = pool.get(link.master.account_id).call(
                "symbols", timeout=settings.snapshot_timeout
            ).get("symbols") or []
        else:
            source_symbols = manager_symbols(masters.connector, link.master)
        dest_names = pool.get(link.dest_id).call(
            "symbols", timeout=settings.snapshot_timeout
        ).get("symbols") or []
    except SourceUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except WorkerDown as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CommandFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    rows = preview_translation(link.rules, sorted(source_symbols), SymbolIndex(dest_names))
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1

    if q:
        needle = q.strip().upper()
        rows = [
            r for r in rows
            if needle in r["source"].upper() or needle in (r["destination"] or "").upper()
        ]
    return {
        "counts": counts,
        "matching": len(rows),
        "sourceTotal": len(source_symbols),
        "destinationTotal": len(dest_names),
        "rows": rows[: max(1, min(limit, 2000))],
    }


@app.post("/v1/links/{link_id}/test", dependencies=[Depends(require_secret)])
def test_link(link_id: str) -> dict[str, Any]:
    """Check a link end to end without placing an order. Works on a stopped or
    dry-run link too, so it can be verified before it is armed."""
    link = engine.links.get(link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="unknown link")
    return run_test(engine, link)


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
