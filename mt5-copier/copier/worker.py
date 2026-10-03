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
from pathlib import Path
from typing import Any

import MetaTrader5 as mt5  # type: ignore

from copier import terminals

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

# A terminal that drops its broker connection reconnects by itself, usually
# within seconds. Re-initializing it in the middle of that only slows it down
# and, worse, outlasts the caller's timeout so the whole worker gets killed.
# So a disconnect is waited out briefly and reported, and only a long one is
# kicked with a fresh login.
RECONNECT_WAIT = 8.0
RELOGIN_AFTER = 90.0
LOGIN_TIMEOUT_MS = 60_000

# After a re-login the terminal downloads the broker's symbol list again. Wait
# for that count to settle before reading it, or a just-enabled symbol can
# still look missing.
SYMBOL_SETTLE_WAIT = 20.0

# MT5 has no "server time" call; the broker's clock is read off its newest
# quote. That is only trustworthy while quotes are fresh, so a reading is kept
# for a while and replaced only by another clean one.
OFFSET_TTL = 600.0
OFFSET_MAX_STALENESS = 600.0

# DEAL_ENTRY_* values that close (part of) a position.
_CLOSING_ENTRIES = frozenset({1, 2, 3})  # OUT, INOUT, OUT_BY

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
        self._disconnected_since: float | None = None
        self._offset: float | None = None
        self._offset_at = 0.0
        self._started = time.time()
        self._cleared_stale = False

    def server_offset(self) -> float | None:
        """Seconds the broker's clock runs ahead of UTC (e.g. 10800 for GMT+3).

        Taken from the newest quote across Market Watch and rounded to the half
        hour, which absorbs the few seconds a quote is old. Returns the last
        good reading, or None before there has been one.
        """
        now = time.time()
        if self._offset is not None and now - self._offset_at < OFFSET_TTL:
            return self._offset
        newest = 0
        for info in mt5.symbols_get() or []:
            if getattr(info, "visible", False):
                newest = max(newest, int(getattr(info, "time", 0) or 0))
        if newest:
            raw = newest - now
            offset = round(raw / 1800) * 1800
            if abs(offset) <= 14 * 3600 and abs(raw - offset) <= OFFSET_MAX_STALENESS:
                self._offset, self._offset_at = float(offset), now
        return self._offset

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
            if not self._cleared_stale:
                self._cleared_stale = True
                stopped = terminals.stop_stale(Path(self.terminal), started_before=self._started)
                if stopped:
                    log.warning("closed leftover terminal(s) %s that blocked the connection", stopped)
                    continue  # retry at once against a fresh terminal
            if attempt < CONNECT_ATTEMPTS - 1:
                log.warning("terminal not ready yet (%s); retrying", error)
                time.sleep(5 * (attempt + 1))
        if not ok:
            message = f"initialize failed: {error}"
            if code in RETRY_CONNECT_CODES:
                message += (
                    ": the MT5 terminal did not answer. Open it once on the server to clear"
                    " any update or login prompt, close it, then restart the copier"
                )
            raise WorkerError("CONNECT_FAILED", message)
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
        self._disconnected_since = None
        log.info("attached to %s on %s", info.login, info.server)

    def relogin(self) -> None:
        """Log the account in again on the running terminal.

        This is what makes the terminal fetch the broker's current symbol list
        and group settings, so an instrument the broker enabled after we
        connected becomes visible. Falls back to a full reconnect if the
        terminal itself is gone.
        """
        if mt5.terminal_info() is None:
            self._ready = False
            self.connect()
            return
        ok = mt5.login(
            self.login, password=self.password, server=self.server, timeout=LOGIN_TIMEOUT_MS
        )
        if not ok:
            log.warning("re-login failed (%s); reconnecting the terminal", mt5.last_error())
            self._ready = False
            self.connect()
            return
        info = mt5.account_info()
        if info is None or int(info.login) != self.login:
            self._ready = False
            self.connect()
            return
        self._ready = True
        self._disconnected_since = None
        log.info("logged in again as %s on %s", info.login, info.server)

    def ensure(self) -> None:
        """Make sure we are attached, logged in and connected to the broker."""
        info = mt5.terminal_info()
        if info is None or not self._ready:
            # The IPC link itself is gone (terminal closed or crashed).
            self._ready = False
            self.connect()
            info = mt5.terminal_info()

        if info is not None and not info.connected:
            deadline = time.time() + RECONNECT_WAIT
            while time.time() < deadline:
                time.sleep(0.5)
                info = mt5.terminal_info()
                if info is None or info.connected:
                    break
            if info is None:
                self._ready = False
                self.connect()
            elif not info.connected:
                now = time.time()
                self._disconnected_since = self._disconnected_since or now
                if now - self._disconnected_since >= RELOGIN_AFTER:
                    log.warning("broker connection down for %.0fs; logging in again",
                                now - self._disconnected_since)
                    self._disconnected_since = now  # one kick per interval
                    self.relogin()
                    info = mt5.terminal_info()
                if info is None or not info.connected:
                    raise WorkerError(
                        "BROKER_DISCONNECTED",
                        "the terminal has lost its connection to the broker; "
                        "it is reconnecting on its own",
                    )
        self._disconnected_since = None

        # Connected, but the account can still have been logged out underneath
        # us (password changed, session kicked by the server).
        account = mt5.account_info()
        if account is None or int(account.login) != self.login:
            log.warning("account %s is no longer logged in; logging in again", self.login)
            self.relogin()

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
        # Broker clock, milliseconds: subtract serverOffset for UTC.
        "openedAtMsc": int(getattr(pos, "time_msc", 0) or 0),
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
    terminal = mt5.terminal_info()
    return {
        "terminal": {
            "connected": bool(terminal.connected) if terminal else False,
            # The AutoTrading toggle; with it off every order is refused.
            "tradeAllowed": bool(terminal.trade_allowed) if terminal else False,
        },
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
        "serverOffset": term.server_offset(),
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
        # What one tick is worth for one lot, in the account currency: what
        # risk-based sizing turns a stop distance into money with.
        "tickSize": float(getattr(info, "trade_tick_size", 0) or 0),
        "tickValue": float(getattr(info, "trade_tick_value", 0) or 0),
    }


def cmd_deals(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Deals of one magic number since a broker-clock time.

    The closing deals give each copy's realized result (profit, swap and
    commission), which the daily-loss and losing-streak limits are built on.
    Opening deals are included for their commission.
    """
    term.ensure()
    magic = int(args["magic"])
    since = int(args.get("since") or 0)
    # Generous bounds on both sides; the exact cut is made on deal.time, which
    # is on the same broker clock as ``since``.
    offset = term.server_offset() or 0
    deals = mt5.history_deals_get(max(since - 86_400, 0), int(time.time() + offset + 2 * 86_400))
    out = []
    for deal in deals or []:
        if int(deal.magic) != magic or int(deal.time) < since:
            continue
        out.append({
            "ticket": int(deal.ticket),
            "positionId": int(deal.position_id),
            "time": int(deal.time),
            "timeMsc": int(getattr(deal, "time_msc", 0) or 0),
            "closing": int(deal.entry) in _CLOSING_ENTRIES,
            "symbol": deal.symbol,
            "volume": float(deal.volume),
            "price": float(deal.price),
            "profit": float(deal.profit),
            "swap": float(deal.swap),
            "commission": float(deal.commission),
        })
    return {"deals": out, "serverOffset": offset}


def _market_request(args: dict[str, Any]) -> dict[str, Any]:
    """The market order a copy sends. Shared by ``open`` and ``check`` so a
    test run validates exactly what a real copy would send."""
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
    return request


def cmd_open(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    term.ensure()
    return _send(_market_request(args))


def cmd_check(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Ask the broker whether an order would be accepted, without sending it.

    ``order_check`` runs the server's own validation (symbol tradable, volume,
    stops, margin) and places nothing.
    """
    term.ensure()
    request = _market_request(args)
    result = mt5.order_check(request)
    if result is None:
        raise WorkerError("CHECK_FAILED", f"order_check returned None: {mt5.last_error()}")
    retcode = int(result.retcode)
    terminal = mt5.terminal_info()
    return {
        # order_check reports success as 0 ("Done"), not TRADE_RETCODE_DONE.
        "ok": retcode in (0, mt5.TRADE_RETCODE_DONE),
        "retcode": retcode,
        "comment": result.comment or "",
        "symbol": request["symbol"],
        "volume": float(request["volume"]),
        "price": float(request["price"]),
        "margin": float(result.margin),
        "marginFree": float(result.margin_free),
        "equity": float(result.equity),
        # The AutoTrading toggle: with it off, order_send is refused even when
        # order_check passes.
        "terminalTradeAllowed": bool(terminal.trade_allowed) if terminal else False,
    }


def cmd_refresh(term: Terminal, args: dict[str, Any]) -> dict[str, Any]:
    """Log the account in again and report whether ``symbol`` is now tradable."""
    before = int(mt5.symbols_total() or 0)
    term.relogin()

    # Let the symbol list finish downloading before we look at it.
    deadline = time.time() + SYMBOL_SETTLE_WAIT
    count, stable_since = before, time.time()
    while time.time() < deadline:
        time.sleep(1.0)
        current = int(mt5.symbols_total() or 0)
        if current != count:
            count, stable_since = current, time.time()
        elif current and time.time() - stable_since >= 3.0:
            break

    symbol = str(args.get("symbol") or "")
    available: bool | None = None
    reason: str | None = None
    if symbol:
        try:
            info = _symbol(symbol)
            # 0 disabled, 3 close only: present but cannot open new trades.
            available = int(info.trade_mode) not in (0, 3)
            if not available:
                reason = f"{symbol} is listed but the broker does not allow opening trades on it"
        except WorkerError as exc:
            available = False
            reason = str(exc)
    return {
        "symbolsBefore": before,
        "symbolsAfter": int(mt5.symbols_total() or 0),
        "symbol": symbol or None,
        "available": available,
        "reason": reason,
    }


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
    "check": cmd_check,
    "refresh": cmd_refresh,
    "deals": cmd_deals,
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
