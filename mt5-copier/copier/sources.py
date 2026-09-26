"""Where a master's open positions are read from.

A destination has to be traded on, so it needs a terminal logged in with its
trading password. A master only has to be *watched*, and the MT5 Manager API
already does that for every account on a server from one connection — which is
what mt5-connector exposes. So the normal master source is the connector: no
terminal, no password for the trader's account, and nothing that could place an
order on it by mistake.

:class:`TerminalMaster` reads a master through its own terminal instead. It is
here for the case where we hold an account's investor password but no manager
access to its server, and is not used yet.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("copier.sources")

# Balance and equity only feed lot scaling, which does not need to be fresh to
# the second. Caching them keeps the cycle down to one connector call.
ACCOUNT_TTL = 30.0


class SourceUnavailable(Exception):
    """The master's positions could not be read this cycle."""


@dataclass(frozen=True)
class ManagerMaster:
    """A master watched through the Manager API on its broker's server."""

    label: str
    server: str
    manager_login: int
    manager_password: str
    account: int

    @property
    def key(self) -> str:
        return f"manager:{self.server}:{self.account}"


@dataclass(frozen=True)
class TerminalMaster:
    """A master watched by logging a terminal in to it. Not used yet."""

    label: str
    account_id: str

    @property
    def key(self) -> str:
        return f"terminal:{self.account_id}"


MasterSpec = ManagerMaster | TerminalMaster


def parse_master(raw: dict[str, Any]) -> MasterSpec:
    kind = str(raw.get("kind") or "MANAGER").upper()
    label = str(raw.get("label") or "master")
    if kind == "MANAGER":
        missing = [k for k in ("server", "managerLogin", "managerPassword", "account") if not raw.get(k)]
        if missing:
            raise ValueError(f"manager master is missing {', '.join(missing)}")
        return ManagerMaster(
            label=label,
            server=str(raw["server"]),
            manager_login=int(raw["managerLogin"]),
            manager_password=str(raw["managerPassword"]),
            account=int(raw["account"]),
        )
    if kind == "TERMINAL":
        if not raw.get("accountId"):
            raise ValueError("terminal master is missing accountId")
        return TerminalMaster(label=label, account_id=str(raw["accountId"]))
    raise ValueError(f"unknown master kind {kind!r}")


class ConnectorClient:
    """Minimal client for mt5-connector's read-only endpoints."""

    def __init__(self, url: str, secret: str, timeout: float = 30.0) -> None:
        self.url = url.rstrip("/")
        self.secret = secret
        self.timeout = timeout

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.url}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Connector-Secret": self.secret},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8") or "{}").get("message", "")
            except Exception:
                pass
            raise SourceUnavailable(
                f"the connector rejected {path}: {exc.code} {detail or exc.reason}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SourceUnavailable(
                f"the MT5 connector is unreachable at {self.url}: {exc}"
            ) from exc
        except json.JSONDecodeError as exc:
            raise SourceUnavailable(f"the connector returned invalid JSON from {path}") from exc


class MasterReader:
    """Turns a master spec into the same snapshot shape a worker returns."""

    def __init__(self, connector: ConnectorClient | None, pool: Any = None) -> None:
        self.connector = connector
        self.pool = pool
        self._accounts: dict[str, tuple[float, dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def snapshot(self, spec: MasterSpec) -> dict[str, Any]:
        if isinstance(spec, ManagerMaster):
            return self._manager_snapshot(spec)
        return self._terminal_snapshot(spec)

    # -- manager ----------------------------------------------------------

    def _creds(self, spec: ManagerMaster) -> dict[str, Any]:
        return {
            "server": spec.server,
            "login": spec.manager_login,
            "password": spec.manager_password,
        }

    def _manager_account(self, spec: ManagerMaster) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            cached = self._accounts.get(spec.key)
            if cached and now - cached[0] < ACCOUNT_TTL:
                return cached[1]
        if self.connector is None:
            raise SourceUnavailable("no connector is configured for manager masters")
        payload = self.connector.post(
            "/v1/clients/get", {**self._creds(spec), "account": spec.account}
        )
        client = payload.get("client") or {}
        balance = float(client.get("balance") or 0.0)
        account = {
            "login": int(client.get("login") or spec.account),
            "name": str(client.get("name") or f"Login {spec.account}"),
            "server": spec.server,
            "company": "",
            "currency": client.get("currency") or "USD",
            "balance": balance,
            "equity": float(client.get("equity") if client.get("equity") is not None else balance),
            "margin": float(client.get("margin") or 0.0),
            "marginFree": 0.0,
            "leverage": int(client.get("leverage") or 0),
            # The Manager API does not report the account's margin mode here.
            # It does not matter: only the destination's mode affects how
            # positions are opened and closed, and that is checked directly.
            "hedging": True,
            "tradeMode": -1,
            # A master is never traded on, whatever its own permissions are.
            "tradeAllowed": False,
        }
        with self._lock:
            self._accounts[spec.key] = (now, account)
        return account

    def _manager_snapshot(self, spec: ManagerMaster) -> dict[str, Any]:
        if self.connector is None:
            raise SourceUnavailable("no connector is configured for manager masters")
        account = self._manager_account(spec)
        payload = self.connector.post(
            "/v1/clients/positions", {**self._creds(spec), "account": spec.account}
        )
        positions = []
        for raw in payload.get("positions") or []:
            try:
                ticket = int(raw.get("positionId") or 0)
            except (TypeError, ValueError):
                continue
            if ticket <= 0:
                continue
            positions.append({
                "ticket": ticket,
                "symbol": str(raw.get("symbol") or ""),
                "side": "BUY" if str(raw.get("direction") or "").upper() == "BUY" else "SELL",
                "volume": float(raw.get("volume") or 0.0),
                "priceOpen": float(raw.get("openPrice") or 0.0),
                "priceCurrent": float(raw.get("currentPrice") or 0.0),
                "sl": float(raw.get("sl") or 0.0),
                "tp": float(raw.get("tp") or 0.0),
                "profit": float(raw.get("profit") or 0.0),
                "swap": 0.0,
                "magic": 0,
                "comment": "",
                # The Manager API only gives a wall-clock time of day here, so
                # the ticket stands in for age: MT5 hands them out in order.
                "openedAt": ticket,
            })
        return {"account": account, "positions": positions, "at": time.time()}

    # -- terminal (future) ------------------------------------------------

    def _terminal_snapshot(self, spec: TerminalMaster) -> dict[str, Any]:
        if self.pool is None:
            raise SourceUnavailable("no worker pool is available for terminal masters")
        return self.pool.get(spec.account_id).call("snapshot", timeout=45)
