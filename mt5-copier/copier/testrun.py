"""A test run of one link, end to end, without placing an order.

It walks the same path a real copy takes: read the master, log in to the
destination, translate the symbol, size the lot, and then ask the broker to
validate the order with ``order_check``, which runs the server's own checks
(symbol tradable, volume, stops, margin) and places nothing.

Every step is reported as pass, warn or fail, so an operator can see that a
link will work before a real trade depends on it. Nothing here changes the
link's state: it is not seeded, armed, or charged with failures.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from copier.pool import CommandFailed, WorkerDown
from copier.rules import symbol_base
from copier.sources import SourceUnavailable, TerminalMaster, manager_symbols

if TYPE_CHECKING:
    from copier.engine import Engine, Link

PASS, WARN, FAIL = "pass", "warn", "fail"

# With nothing open on the master, a sample is sized as if it traded this.
NOMINAL_MASTER_LOT = 1.0
MAX_SAMPLES = 3
# Fallback instruments to try when the master holds nothing and no symbol is
# mapped by hand, most commonly traded first.
COMMON_BASES = ("XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "US30")

_ACCOUNT_KINDS = {0: "demo", 1: "contest", 2: "real money"}


def run_test(engine: "Engine", link: "Link") -> dict[str, Any]:
    steps: list[dict[str, Any]] = []

    def step(key: str, title: str, status: str, detail: str, **extra: Any) -> None:
        steps.append({"key": key, "title": title, "status": status, "detail": detail, **extra})

    def result() -> dict[str, Any]:
        return {
            "ok": all(s["status"] != FAIL for s in steps),
            "at": time.time(),
            "linkId": link.id,
            "linkLabel": link.label,
            "masterLabel": link.master.label,
            "steps": steps,
        }

    # 1. the master
    try:
        master = engine.masters.snapshot(link.master)
    except (SourceUnavailable, WorkerDown, CommandFailed) as exc:
        step("master", "Master account readable", FAIL, str(exc))
        return result()
    m = master["account"]
    step(
        "master", "Master account readable", PASS,
        f"{link.master.label} · equity {float(m['equity']):.2f} · "
        f"{len(master['positions'])} open trade(s)",
    )

    # 2. the destination
    try:
        dest = engine.pool.get(link.dest_id).call("snapshot", timeout=engine.snapshot_timeout)
    except (WorkerDown, CommandFailed) as exc:
        step("slave", "Slave account logged in", FAIL, str(exc))
        return result()
    d = dest["account"]
    step(
        "slave", "Slave account logged in", PASS,
        f"{d['login']} on {d['server']} · {_ACCOUNT_KINDS.get(d.get('tradeMode'), 'unknown')} · "
        f"balance {float(d['balance']):.2f} {d.get('currency', '')} · "
        f"equity {float(d['equity']):.2f}",
    )

    # 3. can it trade at all
    problems = []
    if not d.get("tradeAllowed"):
        problems.append("the broker does not allow trading on this account")
    if not d.get("hedging"):
        problems.append("the account is netting, not hedging")
    terminal = dest.get("terminal") or {}
    if terminal and not terminal.get("tradeAllowed", True):
        problems.append("AutoTrading is switched off in the slave's terminal")
    step(
        "trading", "Slave can place trades", FAIL if problems else PASS,
        "; ".join(problems) or "trading allowed · hedging account · AutoTrading on",
    )

    # 4. the link itself
    state = engine.state.get(link.id)
    if state.halted_reason:
        status, detail = FAIL, f"halted: {state.halted_reason}. Arm it to resume."
    elif not link.enabled:
        status, detail = WARN, "stopped, so nothing is copied until you start it"
    elif link.dry_run:
        status, detail = WARN, "running in dry run: trades are logged, no orders are sent"
    else:
        status, detail = PASS, "running live"
    if link.max_drawdown_pct > 0:
        baseline = float(state.baseline_equity or d["equity"] or 0)
        if baseline > 0:
            drawdown = (baseline - float(d["equity"])) / baseline * 100.0
            detail += (f" · drawdown {max(drawdown, 0):.2f}% of the "
                       f"{link.max_drawdown_pct:.2f}% stop")
    step("link", "Link status", status, detail)

    # 4b. would a risk limit stop a copy right now?
    server_now = engine._server_now(link, dest)
    probe_state = _CountersOnly(state, server_now)
    block = engine._entry_block(link, probe_state, server_now)
    active = _active_limits(link)
    if block:
        _, limit, what, resumes = block
        step("risk", "Risk limits", WARN,
             f"{limit}: {what}. A new trade would not be copied right now; copying resumes {resumes}.")
    else:
        step("risk", "Risk limits", PASS,
             ("nothing is stopping new copies right now · " + ", ".join(active))
             if active else "no risk limits are set")

    # 5. symbols, sizing and the broker's own order check
    try:
        samples = _pick_samples(engine, link, master)
    except (SourceUnavailable, WorkerDown, CommandFailed) as exc:
        step("symbols", "Symbols to test", FAIL, f"could not list the master's symbols: {exc}")
        return result()
    if not samples:
        step("symbols", "Symbols to test", WARN,
             "nothing to test: the master has no open trades, no symbol is mapped by hand, "
             "and none of the common instruments could be found")
        return result()

    cycle = {"index": engine._symbol_index(link.dest_id), "list_refreshed": False}
    for sample in samples:
        _test_sample(engine, link, master, dest, cycle, sample, step)
    return result()


class _CountersOnly:
    """The link's state as the limits see it, rolled to the current broker day
    without touching the real state: a test run must change nothing."""

    def __init__(self, state, server_now: float) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime(server_now))
        same_day = state.day == today
        self.risk_block = state.risk_block
        self.day = today
        self.trades_today = state.trades_today if same_day else 0


def _active_limits(link: "Link") -> list[str]:
    r = link.rules
    out = []
    if r.max_open_positions:
        out.append(f"max {r.max_open_positions} open")
    if r.max_trades_per_day:
        out.append(f"max {r.max_trades_per_day} trades/day")
    if r.max_buy_lots:
        out.append(f"BUY ≤ {r.max_buy_lots:g} lots")
    if r.max_sell_lots:
        out.append(f"SELL ≤ {r.max_sell_lots:g} lots")
    if r.session_start:
        out.append(f"session {r.session_start}–{r.session_end} server time")
    if r.max_daily_loss:
        out.append(f"daily loss ≤ {r.max_daily_loss:g}")
    if r.max_consecutive_losses:
        out.append(f"pause after {r.max_consecutive_losses} losses")
    if r.max_loss_per_trade:
        out.append(f"close a copy at -{r.max_loss_per_trade:g}")
    if r.exit_mode == "TRAILING":
        out.append(f"trailing {r.trail_drawdown_pct:g}% from +{r.trail_activation:g}")
    return out


def _test_sample(engine, link, master, dest, cycle, sample, step) -> None:
    from copier.engine import SymbolLookupFailed

    source = sample["symbol"]
    key = f"symbol:{source}"
    try:
        dest_symbol, volume, refresh = engine._resolve_for_open(
            link, sample, master, dest, cycle
        )
    except SymbolLookupFailed as exc:
        detail = str(exc)
        if exc.refresh:
            detail += " · the slave account was logged in again, which did not help"
        step(key, f"{source} → ?", FAIL, detail, sample=sample["origin"])
        return
    except (CommandFailed, WorkerDown, SourceUnavailable) as exc:
        step(key, f"{source} → ?", FAIL, str(exc), sample=sample["origin"])
        return

    if volume <= 0:
        spec = engine._specs.get((link.dest_id, dest_symbol), (0, {}))[1]
        step(key, f"{source} → {dest_symbol}", FAIL,
             f"the scaled lot is below the {dest_symbol} minimum of {spec.get('volumeMin')}",
             sample=sample["origin"])
        return

    side = link.rules.side_for(sample["side"])
    sizing = (f"{sample['side']} {sample['volume']:g} on the master → "
              f"{side} {volume:g} {dest_symbol} on the slave")
    if refresh:
        sizing += " · found after logging the slave account in again"
    step(key, f"{source} → {dest_symbol}", PASS, sizing, sample=sample["origin"])

    sl, tp = link.rules.stops_for(sample.get("sl") or 0.0, sample.get("tp") or 0.0)
    try:
        check = engine.pool.get(link.dest_id).call("check", {
            "symbol": dest_symbol, "side": side, "volume": volume, "sl": sl, "tp": tp,
            "magic": link.magic, "comment": "test run",
            "deviation": link.rules.max_slippage_points,
        }, timeout=engine.order_timeout)
    except (CommandFailed, WorkerDown) as exc:
        step(f"check:{dest_symbol}", f"Broker check · {dest_symbol}", FAIL, str(exc))
        return

    if not check.get("ok"):
        step(f"check:{dest_symbol}", f"Broker check · {dest_symbol}", FAIL,
             f"the broker would reject it: {check.get('comment') or 'no reason given'} "
             f"(code {check.get('retcode')})")
        return
    detail = (f"the broker would accept {side} {volume:g} · margin "
              f"{float(check.get('margin') or 0):.2f} · free margin after "
              f"{float(check.get('marginFree') or 0):.2f}")
    if not check.get("terminalTradeAllowed", True):
        step(f"check:{dest_symbol}", f"Broker check · {dest_symbol}", WARN,
             detail + " · but AutoTrading is off in the terminal, so it would not be sent")
        return
    step(f"check:{dest_symbol}", f"Broker check · {dest_symbol}", PASS, detail)


def _pick_samples(engine, link, master) -> list[dict[str, Any]]:
    """What to test: the master's real trades first, then hand mappings, then
    a common instrument the master offers."""
    samples: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(symbol: str, origin: str, side: str = "BUY", volume: float = NOMINAL_MASTER_LOT,
            sl: float = 0.0, tp: float = 0.0) -> bool:
        if symbol.upper() in seen or link.rules.filter_reason(symbol):
            return False
        seen.add(symbol.upper())
        samples.append({"symbol": symbol, "side": side, "volume": float(volume),
                        "sl": float(sl or 0.0), "tp": float(tp or 0.0), "origin": origin})
        return len(samples) >= MAX_SAMPLES

    for position in sorted(master["positions"], key=lambda p: int(p["ticket"])):
        if add(position["symbol"], "open trade on the master", position["side"],
               position["volume"], position.get("sl", 0.0), position.get("tp", 0.0)):
            return samples
    for symbol in link.rules.symbol_map:
        if add(symbol, "mapped by hand"):
            return samples
    if samples:
        return samples

    if isinstance(link.master, TerminalMaster):
        names = engine.pool.get(link.master.account_id).call(
            "symbols", timeout=engine.snapshot_timeout).get("symbols") or []
    else:
        names = manager_symbols(engine.masters.connector, link.master)
    by_base: dict[str, str] = {}
    for name in sorted(names, key=len):  # the plainest spelling of each base
        by_base.setdefault(symbol_base(name), name)
    for base in COMMON_BASES:
        if base in by_base and add(by_base[base], "common instrument"):
            break
        if len(samples) >= 1:
            break
    return samples
