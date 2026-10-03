"""The copier roadmap: risk limits, proportional partial closes, slave-side
exits, latency and the journal, and the two new lot modes.

Each test drives the engine against simulated accounts, the way a real cycle
would, and checks what lands on the slave and what gets reported.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from copier.engine import Engine, Link
from copier.journal import Journal
from copier.pool import CommandFailed
from copier.rules import CopyRules
from test_engine import FakeAccount, FakePool, reader, terminal_master
from test_refresh_and_testrun import calls, kinds, last


@pytest.fixture
def world(tmp_path: Path):
    """A master, a slave, an engine with a journal, and a link factory."""
    from copier.state import StateStore

    master = FakeAccount(100003, ["XAUUSD.c", "EURUSD.c", "BTCUSD.c"], balance=10_000.0)
    dest = FakeAccount(910102, ["XAUUSD.s", "EURUSD.s"], balance=10_000.0)
    pool = FakePool({"m": master, "d": dest})
    state = StateStore(tmp_path / "state.json")
    journal = Journal(tmp_path / "journal.jsonl")
    engine = Engine(pool, state, reader(pool), poll_interval=0.01, journal=journal)

    def make_link(dry_run: bool = False, **rules) -> Link:
        rules.setdefault("lot_mode", "MULTIPLIER")
        link = Link(id="L1", label="test", master=terminal_master("m"), dest_id="d",
                    rules=CopyRules(**rules), enabled=True, dry_run=dry_run)
        engine.set_links([link])
        engine.run_link(link)  # seed
        return link

    return master, dest, engine, state, journal, make_link


def copies(dest: FakeAccount) -> list[dict]:
    return list(dest.positions.values())


# -- Batch A: daily trade count, exposure, sessions, lot per equity ---------

def test_max_trades_per_day_blocks_the_rest_and_alerts_once(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(max_trades_per_day=1)

    master.add("XAUUSD.c", "BUY", 0.10)
    master.add("XAUUSD.c", "BUY", 0.10)
    master.add("EURUSD.c", "SELL", 0.10)
    engine.run_link(link)
    engine.run_link(link)

    assert len(copies(dest)) == 1
    assert kinds(engine).count("blocked") == 2
    assert kinds(engine).count("risk") == 1
    assert last(engine, "risk")["trigger"] == "trades_per_day"

    # A new broker day resets the count; trades blocked yesterday stay blocked.
    state.get("L1").day = "2000-01-01"
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(copies(dest)) == 2


def test_exposure_per_direction(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(max_buy_lots=0.15)

    master.add("XAUUSD.c", "BUY", 0.10)
    master.add("XAUUSD.c", "BUY", 0.10)  # would make 0.20 BUY
    master.add("XAUUSD.c", "SELL", 0.10)  # SELL has no limit
    engine.run_link(link)

    assert sorted((p["side"], p["volume"]) for p in copies(dest)) == [("BUY", 0.10), ("SELL", 0.10)]
    assert last(engine, "risk")["trigger"] == "exposure_buy"


def _window(minutes_from_now: int, length: int) -> tuple[str, str]:
    now = time.gmtime(time.time() + minutes_from_now * 60)
    end = time.gmtime(time.time() + (minutes_from_now + length) * 60)
    return f"{now.tm_hour:02d}:{now.tm_min:02d}", f"{end.tm_hour:02d}:{end.tm_min:02d}"


def test_trading_session_blocks_outside_hours(world):
    master, dest, engine, state, journal, make_link = world
    start, end = _window(60, 60)  # opens in an hour
    link = make_link(session_start=start, session_end=end)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert copies(dest) == []
    assert last(engine, "risk")["trigger"] == "session"


def test_trading_session_allows_inside_hours(world):
    master, dest, engine, state, journal, make_link = world
    start, end = _window(-5, 60)
    link = make_link(session_start=start, session_end=end)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert len(copies(dest)) == 1


def test_sessions_follow_the_broker_clock(world):
    master, dest, engine, state, journal, make_link = world
    dest.server_offset = 3 * 3600.0  # broker runs on GMT+3
    start, end = _window(-5 + 180, 60)  # "now" on the broker's clock
    link = make_link(session_start=start, session_end=end)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert len(copies(dest)) == 1


def test_lot_per_equity_step(world):
    master, dest, engine, state, journal, make_link = world
    dest.equity = 22_016.01
    link = make_link(lot_mode="EQUITY_STEP", lot_value=0.01, equity_step=1000)

    master.add("XAUUSD.c", "BUY", 1.00)
    engine.run_link(link)

    assert copies(dest)[0]["volume"] == pytest.approx(0.22)


# -- Batch A: copy behaviour ------------------------------------------------

def test_sl_and_tp_follow_separately(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(copy_tp=False)

    ticket = master.add("XAUUSD.c", "BUY", 0.10, sl=95.0, tp=110.0)
    engine.run_link(link)
    copy = copies(dest)[0]
    assert (copy["sl"], copy["tp"]) == (95.0, 0.0)

    master.positions[ticket]["tp"] = 120.0  # TP is not followed
    engine.run_link(link)
    assert calls(dest, "modify") == 0

    master.positions[ticket]["sl"] = 97.0  # SL is
    engine.run_link(link)
    copy = copies(dest)[0]
    assert (copy["sl"], copy["tp"]) == (97.0, 0.0)


def test_an_equity_ratio_drift_does_not_trim_a_copy(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(lot_mode="EQUITY", lot_value=1.0)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert copies(dest)[0]["volume"] == pytest.approx(0.10)

    master.equity *= 1.5  # the ratio now says 0.06, but the master did nothing
    engine.run_link(link)

    assert copies(dest)[0]["volume"] == pytest.approx(0.10)
    assert "reduce" not in kinds(engine)


def test_a_partial_close_is_proportional_even_with_a_fixed_lot(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(lot_mode="FIXED", lot_value=0.10)

    ticket = master.add("XAUUSD.c", "BUY", 1.00)
    engine.run_link(link)
    master.positions[ticket]["volume"] = 0.50
    engine.run_link(link)

    assert copies(dest)[0]["volume"] == pytest.approx(0.05)
    reduce = last(engine, "reduce")
    assert (reduce["fromVolume"], reduce["volume"]) == (pytest.approx(0.10), pytest.approx(0.05))


def test_a_dry_run_announces_each_trade_once(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(dry_run=True)

    master.add("XAUUSD.c", "BUY", 0.10)
    for _ in range(5):
        engine.run_link(link)

    assert kinds(engine).count("opened") == 1
    assert last(engine, "opened")["dryRun"] is True
    assert copies(dest) == []


def test_a_failing_close_is_reported_once_not_every_cycle(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link()
    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    del master.positions[ticket]
    dest.fail_always["close"] = CommandFailed("ORDER_REJECTED", "market closed")
    for _ in range(5):
        engine.run_link(link)
        engine._close_failures[("L1", copies(dest)[0]["ticket"])]["nextTry"] = 0  # retry now

    assert kinds(engine).count("error") == 1
    assert "close" not in kinds(engine)  # never claimed closed

    dest.fail_always.clear()
    engine.run_link(link)
    assert copies(dest) == []
    assert kinds(engine).count("close") == 1


def test_refused_stops_are_reported_once(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link()
    ticket = master.add("XAUUSD.c", "BUY", 0.10, sl=95.0)
    engine.run_link(link)

    dest.fail_always["modify"] = CommandFailed("ORDER_REJECTED", "invalid stops")
    master.positions[ticket]["sl"] = 99.99
    for _ in range(5):
        engine.run_link(link)

    assert kinds(engine).count("error") == 1


# -- Batch B: money stop, daily loss, losing streak --------------------------

def test_a_copy_is_closed_at_the_loss_per_trade_and_not_recopied(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(max_loss_per_trade=50)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    copies(dest)[0]["profit"] = -60.0
    dest.positions[copies(dest)[0]["ticket"]]["profit"] = -60.0
    engine.run_link(link)
    engine.run_link(link)

    assert copies(dest) == []
    stop = last(engine, "loss_stop")
    assert stop["loss"] == -60.0 and stop["limit"] == 50
    assert calls(dest, "open") == 1  # master still open, not copied again


def _deal(position: int, profit: float, *, at: float, closing: bool = True, magic: int | None = None):
    deal = {"ticket": position * 10, "positionId": position, "time": int(at),
            "timeMsc": int(at * 1000), "closing": closing, "symbol": "XAUUSD.s",
            "volume": 0.1, "price": 100.0, "profit": profit, "swap": 0.0, "commission": 0.0}
    if magic is not None:
        deal["magic"] = magic
    return deal


def test_the_daily_loss_limit_blocks_new_copies(world):
    master, dest, engine, state, journal, make_link = world
    dest.deals = [_deal(1, -70, at=time.time() - 60), _deal(2, -55, at=time.time() - 30)]
    link = make_link(max_daily_loss=100)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert copies(dest) == []
    risk = last(engine, "risk")
    assert risk["trigger"] == "daily_loss"
    assert "-125.00" in risk["detail"]


def test_yesterdays_losses_do_not_count_today(world):
    master, dest, engine, state, journal, make_link = world
    dest.deals = [_deal(1, -500, at=time.time() - 2 * 86_400)]
    link = make_link(max_daily_loss=100)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert len(copies(dest)) == 1


def test_a_losing_streak_pauses_until_armed(world):
    master, dest, engine, state, journal, make_link = world
    now = time.time()
    dest.deals = [_deal(1, 10, at=now - 300), _deal(2, -5, at=now - 200), _deal(3, -8, at=now - 100)]
    link = make_link(max_consecutive_losses=2)

    assert state.get("L1").risk_block
    assert last(engine, "risk")["trigger"] == "loss_streak"

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert copies(dest) == []

    engine.arm("L1")  # resumes from now, with a fresh streak
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(copies(dest)) == 1


def test_a_win_ends_the_streak(world):
    master, dest, engine, state, journal, make_link = world
    now = time.time()
    dest.deals = [_deal(1, -5, at=now - 300), _deal(2, -8, at=now - 200), _deal(3, 4, at=now - 100)]
    make_link(max_consecutive_losses=2)

    assert state.get("L1").risk_block is None


# -- Batch C: trailing -------------------------------------------------------

def _set_profit(dest: FakeAccount, profit: float) -> None:
    for position in dest.positions.values():
        position["profit"] = profit


def test_trailing_exits_at_peak_minus_the_drawdown(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(exit_mode="TRAILING", trail_activation=5, trail_drawdown_pct=20)
    master.add("XAUUSD.c", "BUY", 0.10, sl=95.0, tp=110.0)
    engine.run_link(link)
    assert (copies(dest)[0]["sl"], copies(dest)[0]["tp"]) == (0.0, 0.0)  # own exit only

    for profit in (10.0, 50.0, 41.0):  # peak 50, floor 40: still in
        _set_profit(dest, profit)
        engine.run_link(link)
    assert len(copies(dest)) == 1

    _set_profit(dest, 39.5)
    engine.run_link(link)
    assert copies(dest) == []
    exit_ = last(engine, "trailing_exit")
    assert (exit_["peak"], exit_["floor"], exit_["retracement"], exit_["exitProfit"]) == (50, 40, 10, 39.5)

    engine.run_link(link)
    assert calls(dest, "open") == 1  # the master still holds it; not copied again


def test_trailing_waits_for_the_activation_profit(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(exit_mode="TRAILING", trail_activation=5, trail_drawdown_pct=20)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    for profit in (4.0, 1.0, -3.0):
        _set_profit(dest, profit)
        engine.run_link(link)

    assert len(copies(dest)) == 1


def test_the_peak_survives_a_restart(world, tmp_path):
    from copier.state import StateStore

    master, dest, engine, state, journal, make_link = world
    link = make_link(exit_mode="TRAILING", trail_activation=5, trail_drawdown_pct=20)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    _set_profit(dest, 50.0)
    engine.run_link(link)
    state.save()

    reloaded = StateStore(tmp_path / "state.json")
    fresh = Engine(engine.pool, reloaded, reader(engine.pool), poll_interval=0.01)
    fresh.set_links([link])
    _set_profit(dest, 39.0)
    fresh.run_link(link)

    assert copies(dest) == []


# -- Batch D: latency, slippage, journal ------------------------------------

def test_latency_slippage_and_the_journal(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link()
    master.server_offset = 2 * 3600.0  # master broker on GMT+2
    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    master.positions[ticket]["priceOpen"] = 99.90
    executed = time.time() - 0.25
    master.positions[ticket]["openedAtMsc"] = int((executed + 2 * 3600) * 1000)
    dest.fill_price = 100.00

    engine.run_link(link)

    opened = last(engine, "opened")
    assert 200 <= opened["latencyMs"] <= 5000
    assert opened["executionMs"] >= 0
    assert opened["slippagePoints"] == pytest.approx(10.0)  # paid 0.10 more, point 0.01

    dest.positions[opened["ticket"]]["profit"] = 12.5
    del master.positions[ticket]
    engine.run_link(link)

    [trade] = journal.trades()
    assert trade["status"] == "closed"
    assert trade["masterTicket"] == ticket and trade["ticket"] == opened["ticket"]
    assert trade["profit"] == 12.5 and trade["closeReason"] == "master closed"
    assert trade["latencyMs"] == opened["latencyMs"]


def test_a_manager_masters_clock_is_learned_from_a_fresh_trade(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link()
    master.server_offset = None  # like a Manager API master: no clock reported
    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    master.positions[ticket]["openedAtMsc"] = int((time.time() - 0.4 + 3 * 3600) * 1000)

    engine.run_link(link)

    assert engine._master_offsets[link.master.key] == 3 * 3600.0
    assert 300 <= last(engine, "opened")["latencyMs"] <= 5000


# -- Batch E: risk-percent sizing -------------------------------------------

def test_risk_percent_sizes_from_the_masters_stop(world):
    master, dest, engine, state, journal, make_link = world
    dest.equity = 22_016.01
    link = make_link(lot_mode="RISK_PERCENT", lot_value=1.0)

    ticket = master.add("XAUUSD.c", "BUY", 0.50, sl=1990.0)
    master.positions[ticket]["priceOpen"] = 2000.0
    engine.run_link(link)

    # 1% of 22,016 = 220.16 at risk; 10.00 stop = 1000 ticks x 1.00 per lot
    assert copies(dest)[0]["volume"] == pytest.approx(0.22)


def test_risk_percent_without_a_master_stop_is_skipped_without_a_relogin(world):
    master, dest, engine, state, journal, make_link = world
    link = make_link(lot_mode="RISK_PERCENT", lot_value=1.0)

    master.add("XAUUSD.c", "BUY", 0.50)  # no SL
    engine.run_link(link)

    assert copies(dest) == []
    assert "needs a stop loss" in last(engine, "skipped")["reason"]
    assert calls(dest, "refresh") == 0


# -- the test run knows about the limits -------------------------------------

def test_a_test_run_reports_a_limit_that_would_stop_a_copy_now(world):
    from copier.testrun import run_test

    master, dest, engine, state, journal, make_link = world
    start, end = _window(60, 60)
    link = make_link(session_start=start, session_end=end)
    master.add("XAUUSD.c", "BUY", 0.10)
    before = state.get("L1").to_dict()

    result = run_test(engine, link)

    risk = next(s for s in result["steps"] if s["key"] == "risk")
    assert risk["status"] == "warn"
    assert "Trading session" in risk["detail"]
    assert state.get("L1").to_dict() == before  # a test run changes nothing


def test_a_test_run_sizes_samples_like_the_masters_last_trade(world):
    from copier.testrun import run_test

    master, dest, engine, state, journal, make_link = world
    link = make_link(symbol_map={"XAUUSD.c": "XAUUSD.s"})
    ticket = master.add("XAUUSD.c", "BUY", 0.25)
    engine.run_link(link)  # copied: the journal now knows the master trades 0.25
    del master.positions[ticket]
    engine.run_link(link)

    result = run_test(engine, link)

    sized = next(s for s in result["steps"] if s["key"] == "symbol:XAUUSD.C")
    assert "0.25-lot master trade" in sized["sample"]
    assert "BUY 0.25 on the master" in sized["detail"]
