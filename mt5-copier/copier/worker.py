"""One worker process per trading account.

The MetaTrader5 package is a singleton per OS process: ``mt5.initialize`` binds
the process to one terminal, and one account inside it. A copier needs several
accounts live at the same time, so the engine runs this module as a subprocess
for each account and talks to it over newline-delimited JSON on stdin/stdout.

Requests   {"id": 1, "cmd": "snapshot", "args": {}}
Responses  {"id": 1, "ok": true, "result": {...}}
           {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}

stdout carries the protocol and nothing else; all logging goes to stderr.

Run as:  python -m copier.worker --login N --server S --terminal PATH
with the account password on stdin as the first line (never on argv, where
other users of the machine could read it out of the process list).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Any

import MetaTrader5 as mt5  # type: ignore

log = logging.getLogger("copier.worker")

# Retcodes worth retrying: the price moved between our quote and the server's fill.
RETRY_RETCODES = frozenset({
    10004,  # REQUOTE
    10008,  # PLACED (async accepted, re-check)
    10020,  # PRICE_CHANGED
    10021,  # PRICE_OFF (no quotes)
    10024,  # TOO_MANY_REQUESTS
    10027,  # SERVER_DISABLES_AT (algo trading off server-side)
    10030,  # INVALID_FILL (we retry with the next filling mode)
})

CONNECT_ATTEMPTS = 4
CONNECT_TIMEOUT_MS = 120_000
# -10005 IPC timeout / -10003 IPC init failed: the terminal is still coming up.
# Anything else (bad password, unknown server) will not fix itself.
RETRY_CONNECT_CODES = frozenset({-10005, -10003, -10004})

# Symbol filling bitmask (SYMBOL_FILLING_*) -> order filling constant.
_FILLING_CHOICES = (
    (1, mt5.ORDER_FILLING_FOK),
    (2, mt5.ORDER_FILLING_IOC),
    (4, mt5.ORDER_FILLING_BOC),
)


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Terminal:
    """Owns this process's single MT5 attachment and re-establishes it on drop."""

    def __init__(self, terminal: str, login: int, password: str, server: str) -> None:
        self.terminal = terminal
        self.login = int(login)
        self.password = password
        self.server = server
        self._ready = False

    def connect(self) -> None:
        if self._ready and mt5.terminal_info() is not None:
            return
        ok = False
        error: Any = None
        # A terminal that has never run takes a couple of minutes to start:
        # it unpacks, fetches the broker's server list and syncs symbols, and
        # answers IPC with -10005 until it is ready. Retry rather than give up.
        for attempt in range(CONNECT_ATTEMPTS):
            try:
                mt5.shutdown()
            except Exception:
                pass
            ok = mt5.initialize(
                self.terminal,
                login=self.login,
                password=self.password,
                server=self.server,
                timeout=CONNECT_TIMEOUT_MS,
                portable=True,
            )
            if ok:
                break
            error = mt5.last_error()
            code = error[0] if isinstance(error, tuple) else None
            if code not in RETRY_CONNECT_CODES:
                break  # bad password or unknown server: retrying will not help
            if attempt < CONNECT_ATTEMPTS - 1:
                log.warning("terminal not ready yet (%s); retrying", error)
                time.sleep(5 * (attempt + 1))
        if not ok:
            raise WorkerError("CONNECT_FAILED", f"initialize failed: {error}")
        info = mt5.account_info()
        if info is None:
            raise WorkerError("CONNECT_FAILED", f"account_info failed: {mt5.last_error()}")
        if int(info.login) != self.login:
            # Attached to the wrong terminal — a misconfigured path would otherwise
            # let us place orders on somebody else's account.
            raise WorkerError(
                "WRONG_ACCOUNT",
                f"terminal {self.terminal} is logged in as {info.login}, expected {self.login}",
            )
        self._ready = True
        log.info("attached to %s on %s", info.login, info.server)

    def ensure(self) -> None:
        info = mt5.terminal_info()
        if info is None or not info.connected:
            self._ready = False
        self.connect()

    def close(self) -> None:
        try:
            mt5.shutdown()
        except Exception:
            pass
        self._ready = False


def _filling_for(symbol_info) -> int:
    """Pick a filling mode the symbol actually supports.

    Brokers differ: the master's symbol may allow FOK only while the slave's
    allows IOC only, so this is resolved per symbol on each side.
    """
    mask = int(getattr(symbol_info, "filling_mode", 0) or 0)
    for bit, order_filling in _FILLING_CHOICES:
        if mask & bit:
            return order_filling
    return mt5.ORDER_FILLING_IOC


def _symbol(name: str):
    """Fetch a symbol, making it visible in Market Watch first if needed."""
    info = mt5.symbol_info(name)
    if info is None:
        raise WorkerError("SYMBOL_UNKNOWN", f"{name} does not exist on this account")
    if not info.visible:
        if not mt5.symbol_select(name, True):
            raise WorkerError("SYMBOL_UNAVAILABLE", f"cannot select {name}: {mt5.last_error()}")
        info = mt5.symbol_info(name) or info
    return info


def _price(name: str, side: int) -> float:
    """Current executable price: ask to buy, bid to sell."""
    tick = mt5.symbol_info_tick(name)
    if tick is None or (not tick.ask and not tick.bid):
        raise WorkerError("NO_QUOTE", f"no live quote for {name}")
    return float(tick.ask if side == mt5.ORDER_TYPE_BUY else tick.bid)


def _position_dict(pos) -> dict[str, Any]:
    return {
        "ticket": int(pos.ticket),
        "symbol": pos.symbol,
        "side": "BUY" if pos.type == mt5.POSITION_TYPE_BUY else "SELL",
        "volume": float(pos.volume),
        "priceOpen": float(pos.price_open),
        "priceCurrent": float(pos.price_current),
        "sl": float(pos.sl),
        "tp": float(pos.tp),
        "profit": float(pos.profit),
        "swap": float(pos.swap),
        "magic": int(pos.magic),
        "comment": pos.comment or "",
        "openedAt": int(pos.time),
    }


def _send(request: dict[str, Any], *, attempts: int = 3) -> dict[str, Any]:
    """order_send with retries for transient price/fill rejections."""
    last: Any = None
    filling_tried: set[int] = set()
    for attempt in range(attempts):
        result = mt5.order_send(request)
        if result is None:
            last = {"retcode": -1, "comment": f"order_send returned None: {mt5.last_error()}"}
        else:
            last = {
                "retcode": int(result.retcode),
                "comment": result.comment or "",
                "deal": int(result.deal),
                "order": int(result.order),
                "volume": float(result.volume),
                "price": float(result.price),
            }
            if result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
                return last
            if result.retcode not in RETRY_RETCODES:
                break
            if result.retcode == 10030:  # INVALID_FILL — step to the next mode
                filling_tried.add(request.get("type_filling", -1))
                for _, mode in _FILLING_CHOICES:
                    if mode not in filling_tried:
                        request["type_filling"] = mode
                        break
        if attempt < attempts - 1:
            time.sleep(0.4 * (attempt + 1))
            # refresh the price for market orders before retrying
            if request.get("action") == mt5.TRADE_ACTION_DEAL and "type" in request:
                try:
                    request["price"] = _price(request["symbol"], request["type"])
                except WorkerError:
                    pass
    raise WorkerError("ORDER_REJECTED", json.dumps(last))


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_ping(_: Terminal, __: dict[str, Any]) -> dict[str, Any]:
    return {"pong": True, "at": time.time()}


def cmd_snapshot(term: Terminal, _: dict[str, Any]) -> dict[str, Any]:
    term.ensure()
    info = mt5.account_info()
    if info is None:
        raise WorkerError("NOT_CONNECTED", f"account_info failed: {mt5.last_error()}")
    positions = mt5.positions_get()
    return {
        "account": {
            "login": int(info.login),
            "name": info.name,
            "server": info.server,
            "company": info.company,
            "currency": info.currency,
            "balance": float(info.balance),
            "equity": float(info.equity),
            "margin": float(info.margin),
            "marginFree": float(info.margin_free),
            "leverage": int(info.leverage),
            # 2 == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
            "hedging": int(info.margin_mode) == 2,
            # 0 DEMO, 1 CONTEST, 2 REAL
            "tradeMode": int(info.trade_mode),
            "tradeAllowed": bool(info.trade_allowed),
        },
        "positions": [_position_dict(p) for p in (positions or [])],
        "at": time.time(),
    }


def cmd_symbols(term: Terminal, _: dict[str, Any]) -> dict[str, Any]:
    term.ensure()
    return {"symbols": [s.name for s in (mt5.symbols_get() or [])]}


def cmd_spec(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Volume and price constraints for one symbol, used for lot rounding."""
    term.ensure()
    info = _symbol(str(args["symbol"]))
    return {
        "symbol": info.name,
        "digits": int(info.digits),
        "volumeMin": float(info.volume_min),
        "volumeMax": float(info.volume_max),
        "volumeStep": float(info.volume_step),
        "stopsLevel": int(info.trade_stops_level),
        "point": float(info.point),
        "tradeMode": int(info.trade_mode),
    }


def cmd_open(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    term.ensure()
    symbol = str(args["symbol"])
    side = mt5.ORDER_TYPE_BUY if str(args["side"]).upper() == "BUY" else mt5.ORDER_TYPE_SELL
    info = _symbol(symbol)
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(args["volume"]),
        "type": side,
        "price": _price(symbol, side),
        "deviation": int(args.get("deviation", 20)),
        "magic": int(args.get("magic", 0)),
        "comment": str(args.get("comment", ""))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _filling_for(info),
    }
    for key in ("sl", "tp"):
        value = args.get(key)
        if value:
            request[key] = float(value)
    return _send(request)


def cmd_close(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Close a position, fully or partially (hedging accounts)."""
    term.ensure()
    ticket = int(args["ticket"])
    found = mt5.positions_get(ticket=ticket)
    if not found:
        # Already gone — SL/TP may have fired. Idempotent by design.
        return {"retcode": int(mt5.TRADE_RETCODE_DONE), "comment": "position already closed",
                "alreadyClosed": True}
    pos = found[0]
    volume = float(args.get("volume") or pos.volume)
    volume = min(volume, float(pos.volume))
    opposite = (
        mt5.ORDER_TYPE_SELL if pos.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    )
    info = _symbol(pos.symbol)
    return _send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": volume,
        "type": opposite,
        "position": ticket,
        "price": _price(pos.symbol, opposite),
        "deviation": int(args.get("deviation", 20)),
        "magic": int(pos.magic),
        "comment": str(args.get("comment", "close"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _filling_for(info),
    })


def cmd_modify(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Set stop loss / take profit on an existing position."""
    term.ensure()
    ticket = int(args["ticket"])
    found = mt5.positions_get(ticket=ticket)
    if not found:
        return {"retcode": int(mt5.TRADE_RETCODE_DONE), "comment": "position already closed",
                "alreadyClosed": True}
    pos = found[0]
    return _send({
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": ticket,
        "sl": float(args.get("sl") or 0.0),
        "tp": float(args.get("tp") or 0.0),
        "magic": int(pos.magic),
    }, attempts=2)


COMMANDS = {
    "ping": cmd_ping,
    "snapshot": cmd_snapshot,
    "symbols": cmd_symbols,
    "spec": cmd_spec,
    "open": cmd_open,
    "close": cmd_close,
    "modify": cmd_modify,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="MT5 copier account worker")
    parser.add_argument("--login", type=int, required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--label", default="")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format=f"%(asctime)s %(levelname)s [{args.label or args.login}] %(message)s",
    )

    password = sys.stdin.readline().rstrip("\n")
    if not password:
        log.error("no password on stdin")
        return 2

    term = Terminal(args.terminal, args.login, password, args.server)
    out = sys.stdout

    def reply(payload: dict[str, Any]) -> None:
        out.write(json.dumps(payload) + "\n")
        out.flush()

    try:
        term.connect()
    except WorkerError as exc:
        reply({"id": 0, "ok": False, "error": {"code": exc.code, "message": str(exc)}})
        return 1
    reply({"id": 0, "ok": True, "result": {"ready": True, "login": args.login}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = request.get("id", 0)
        name = request.get("cmd", "")
        handler = COMMANDS.get(name)
        if handler is None:
            reply({"id": req_id, "ok": False,
                   "error": {"code": "UNKNOWN_COMMAND", "message": name}})
            continue
        try:
            reply({"id": req_id, "ok": True, "result": handler(term, request.get("args") or {})})
        except WorkerError as exc:
            reply({"id": req_id, "ok": False,
                   "error": {"code": exc.code, "message": str(exc)}})
        except Exception as exc:  # never let one bad command kill the worker
            log.exception("command %s failed", name)
            reply({"id": req_id, "ok": False,
                   "error": {"code": "WORKER_ERROR", "message": f"{type(exc).__name__}: {exc}"}})

    term.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
