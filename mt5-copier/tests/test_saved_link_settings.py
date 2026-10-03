"""The live link's own saved settings, feature by feature.

Loads the rules saved for the real link in ``data/copier.json`` (TDFX 100003 ->
Wyncrest 910102) and drives the engine through each feature against simulated
accounts sized like the real ones, checking the outcome matches the setting.
Where a test needs a value, it reads it from the saved rules, so the suite
follows the settings if they change. Skipped when there is no saved link.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from copier import engine as engine_module
from copier.engine import Engine, Link
from copier.journal import Journal
from copier.pool import WorkerDown
from copier.rules import CopyRules
from copier.state import StateStore
from test_engine import FakeAccount, FakePool, reader, terminal_master
from test_refresh_and_testrun import calls, kinds, last

DATA = Path(__file__).resolve().parents[2] / "data" / "copier.json"
pytestmark = pytest.mark.skipif(not DATA.is_file(), reason="no saved link to test")

MASTER_EQUITY = 6668.62   # TDFX 100003 at the time of testing
SLAVE_EQUITY = 21959.07   # Wyncrest 910102


def saved() -> dict:
    return json.loads(DATA.read_text(encoding="utf-8-sig"))["links"][0]


@pytest.fixture
def live(tmp_path):
    raw = saved()
    rules = CopyRules.from_dict(raw["rules"])
    master = FakeAccount(100003, ["XAUUSD.c", "BTCUSD.c"], balance=MASTER_EQUITY)
    slave = FakeAccount(910102, ["XAUUSD.r", "BTCUSD.r"], balance=SLAVE_EQUITY)
    pool = FakePool({"m": master, "d": slave})
    state = StateStore(tmp_path / "state.json")
    journal = Journal(tmp_path / "journal.jsonl")
    engine = Engine(pool, state, reader(pool), poll_interval=0.01, journal=journal)

    def make(dry_run: bool = False, **rule_overrides) -> Link:
        merged = CopyRules.from_dict({**raw["rules"], **rule_overrides}) if rule_overrides else rules
        link = Link(id=raw["id"], label=raw["label"], master=terminal_master("m"), dest_id="d",
                    rules=merged, enabled=True, dry_run=dry_run,
                    max_drawdown_pct=float(raw.get("maxDrawdownPct") or 0))
        engine.set_links([link])
        engine.run_link(link)  # seed, as a freshly started copier would
        return link

    return master, slave, engine, state, journal, rules, make


def copies(slave: FakeAccount) -> list[dict]:
    return sorted(slave.positions.values(), key=lambda p: p["ticket"])


def set_profit(slave: FakeAccount, profit: float) -> None:
    for position in slave.positions.values():
        position["profit"] = profit


# -- copying -----------------------------------------------------------------

def _expected_vol(rules, master_vol: float) -> float:
    """Slave volume the engine should produce for a given master volume, using saved rules."""
    from test_engine import SPEC
    raw = rules.scale_volume(
        master_vol,
        master_balance=MASTER_EQUITY,
        dest_balance=SLAVE_EQUITY,
        master_equity=MASTER_EQUITY,
        dest_equity=SLAVE_EQUITY,
    )
    return rules.round_volume(raw, SPEC)


def test_lot_sizing_and_symbol_mapping(live):
    """The saved lot mode copies the right size and maps .c symbols to .r ones."""
    master, slave, engine, state, journal, rules, make = live
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    master.add("XAUUSD.c", "SELL", 0.01)
    engine.run_link(link)

    ev = _expected_vol(rules, 0.01)
    assert [(p["symbol"], p["side"], p["volume"]) for p in copies(slave)] == [
        ("BTCUSD.r", "BUY", pytest.approx(ev)),
        ("XAUUSD.r", "SELL", pytest.approx(ev)),
    ]


def test_trailing_mode_does_not_copy_the_masters_stops(live):
    master, slave, engine, state, journal, rules, make = live
    assert rules.exit_mode == "TRAILING"
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01, sl=80_000.0, tp=90_000.0)
    engine.run_link(link)

    assert (copies(slave)[0]["sl"], copies(slave)[0]["tp"]) == (0.0, 0.0)


def test_a_master_close_closes_the_copy_and_is_journaled(live):
    master, slave, engine, state, journal, rules, make = live
    link = make()
    ticket = master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    set_profit(slave, 1.25)
    del master.positions[ticket]
    engine.run_link(link)

    assert copies(slave) == []
    assert last(engine, "close")["profit"] == 1.25
    [trade] = journal.trades()
    assert trade["status"] == "closed" and trade["closeReason"] == "master closed"


def test_a_partial_close_shrinks_the_copy_by_the_same_share(live):
    master, slave, engine, state, journal, rules, make = live
    link = make()
    ev = _expected_vol(rules, 0.02)
    ticket = master.add("BTCUSD.c", "BUY", 0.02)
    engine.run_link(link)
    assert copies(slave)[0]["volume"] == pytest.approx(ev)

    master.positions[ticket]["volume"] = 0.01      # master closes half
    engine.run_link(link)
    assert copies(slave)[0]["volume"] == pytest.approx(ev / 2)


def test_an_equity_drift_does_not_trim_a_copy(live):
    master, slave, engine, state, journal, rules, make = live
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    ev = _expected_vol(rules, 0.01)
    master.equity *= 1.4  # account changed, but the master position did nothing
    engine.run_link(link)

    assert copies(slave)[0]["volume"] == pytest.approx(ev)


# -- risk limits -------------------------------------------------------------

def test_max_open_copies(live):
    master, slave, engine, state, journal, rules, make = live
    cap = rules.max_open_positions
    assert cap == 2
    link = make()
    for _ in range(cap + 1):
        master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    engine.run_link(link)

    assert len(copies(slave)) == cap
    assert last(engine, "risk")["trigger"] == "max_open"
    # Closing one does not copy the blocked trade late.
    del master.positions[sorted(master.positions)[0]]
    engine.run_link(link)
    engine.run_link(link)
    assert len(copies(slave)) == cap - 1


def test_max_sell_exposure(live):
    master, slave, engine, state, journal, rules, make = live
    limit = rules.max_sell_lots
    assert limit == pytest.approx(0.03)
    link = make()
    # SELL 0.03: slave gets 0.03 — exactly at the limit, still allowed
    master.add("BTCUSD.c", "SELL", 0.03)
    engine.run_link(link)
    assert [(p["side"], p["volume"]) for p in copies(slave)] == [("SELL", pytest.approx(0.03))]

    # SELL another 0.01: total would be 0.04 > 0.03 limit, blocked
    master.add("XAUUSD.c", "SELL", 0.01)
    engine.run_link(link)
    assert len(copies(slave)) == 1
    risk = last(engine, "risk")
    assert risk["trigger"] == "exposure_sell"
    assert "0.03 + 0.01 lots would exceed the 0.03-lot limit" in risk["detail"]


def test_max_buy_exposure(live):
    master, slave, engine, state, journal, rules, make = live
    assert rules.max_buy_lots == pytest.approx(1.0)
    link = make()
    # BUY 1.01: slave gets 1.01 > 1.0 limit, blocked
    master.add("BTCUSD.c", "BUY", 1.01)
    engine.run_link(link)
    assert copies(slave) == []
    assert last(engine, "risk")["trigger"] == "exposure_buy"

    # BUY 1.00: slave gets 1.00 = limit, allowed (check is strictly greater)
    master.add("XAUUSD.c", "BUY", 1.00)
    engine.run_link(link)
    assert [p["volume"] for p in copies(slave)] == [pytest.approx(1.00)]


def test_max_trades_per_day(live):
    master, slave, engine, state, journal, rules, make = live
    limit = rules.max_trades_per_day
    assert limit > 0
    link = make()
    for _ in range(limit):  # open and close one at a time
        ticket = master.add("BTCUSD.c", "BUY", 0.01)
        engine.run_link(link)
        del master.positions[ticket]
        engine.run_link(link)
    assert state.get(link.id).trades_today == limit

    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    assert copies(slave) == []
    risk = last(engine, "risk")
    assert risk["trigger"] == "trades_per_day"
    assert f"{limit} of {limit} copied today" in risk["detail"]


def _deal(position: int, profit: float, *, at: float) -> dict:
    return {"ticket": position * 10, "positionId": position, "time": int(at),
            "timeMsc": int(at * 1000), "closing": True, "symbol": "BTCUSD.r",
            "volume": 0.03, "price": 84_000.0, "profit": profit, "swap": 0.0, "commission": 0.0}


def test_max_daily_loss_counts_realized_and_floating(live):
    master, slave, engine, state, journal, rules, make = live
    limit = rules.max_daily_loss
    assert limit > 6
    realized = -(limit - 6)  # closed earlier today: within the limit on its own
    slave.deals = [_deal(1, realized, at=time.time() - 600)]
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    assert len(copies(slave)) == 1  # still allowed

    set_profit(slave, -7.0)  # realized + 7 floating = one past the limit
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.01)
    engine.run_link(link)

    assert len(copies(slave)) == 1
    risk = last(engine, "risk")
    assert risk["trigger"] == "daily_loss" and f"-{limit + 1:.2f}" in risk["detail"]


def test_max_consecutive_losses_pauses_until_resumed(live):
    master, slave, engine, state, journal, rules, make = live
    streak = rules.max_consecutive_losses
    assert streak == 4
    now = time.time()
    slave.deals = [_deal(i, -1.0, at=now - 600 + i) for i in range(1, streak + 1)]
    link = make()
    assert state.get(link.id).risk_block
    assert last(engine, "risk")["trigger"] == "loss_streak"

    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    assert copies(slave) == []

    engine.arm(link.id)  # "Resume" on the Copier page
    engine.run_link(link)
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    assert len(copies(slave)) == 1


def test_three_losses_do_not_pause(live):
    master, slave, engine, state, journal, rules, make = live
    now = time.time()
    slave.deals = [_deal(i, -1.0, at=now - 600 + i) for i in range(1, rules.max_consecutive_losses)]
    link = make()
    assert state.get(link.id).risk_block is None


def test_max_loss_per_trade_closes_the_copy(live):
    master, slave, engine, state, journal, rules, make = live
    assert rules.max_loss_per_trade == 22
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    set_profit(slave, -21.99)
    engine.run_link(link)
    assert len(copies(slave)) == 1  # not yet

    set_profit(slave, -22.0)
    engine.run_link(link)
    engine.run_link(link)
    assert copies(slave) == []
    assert last(engine, "loss_stop")["loss"] == -22.0
    assert calls(slave, "open") == 1  # master still open: not copied again


def test_drawdown_stop_flattens_and_halts(live):
    master, slave, engine, state, journal, rules, make = live
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    slave.equity = SLAVE_EQUITY * (1 - link.max_drawdown_pct / 100) - 1  # just past -10%
    engine.run_link(link)

    assert copies(slave) == []
    assert state.get(link.id).halted_reason
    assert last(engine, "halted")


# -- profit protection -------------------------------------------------------

def test_trailing_starts_at_the_activation_profit(live):
    master, slave, engine, state, journal, rules, make = live
    assert (rules.trail_activation, rules.trail_drawdown_pct) == (5, 20)
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    for profit in (4.9, 1.0, 3.0):  # never reached +5: trailing stays off
        set_profit(slave, profit)
        engine.run_link(link)
    assert len(copies(slave)) == 1


def test_trailing_exits_at_80_percent_of_the_peak(live):
    master, slave, engine, state, journal, rules, make = live
    link = make()
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    for profit in (6.0, 10.0, 8.01):  # peak 10, floor 8.00
        set_profit(slave, profit)
        engine.run_link(link)
    assert len(copies(slave)) == 1

    set_profit(slave, 8.0)
    engine.run_link(link)
    assert copies(slave) == []
    exit_ = last(engine, "trailing_exit")
    assert (exit_["peak"], exit_["floor"], exit_["retracement"]) == (10.0, 8.0, 2.0)


# -- modes and health --------------------------------------------------------

def test_dry_run_sends_nothing_and_reports_once(live):
    master, slave, engine, state, journal, rules, make = live
    link = make(dry_run=True)
    master.add("BTCUSD.c", "BUY", 0.01)
    for _ in range(3):
        engine.run_link(link)

    assert copies(slave) == []
    assert calls(slave, "open") == 0
    assert kinds(engine).count("opened") == 1


def test_an_unreadable_master_is_reported_and_its_return(live, monkeypatch):
    master, slave, engine, state, journal, rules, make = live
    monkeypatch.setattr(engine_module, "OUTAGE_ALERT_AFTER", 0.0)
    link = make()
    master.fail_on["snapshot"] = WorkerDown("the MT5 connector is unreachable")
    engine._safe_run(link)
    engine._safe_run(link)

    assert [k for k in kinds(engine) if k in ("outage", "recovered")] == ["outage", "recovered"]


def test_a_slave_out_of_margin_alerts_once_per_trade(live):
    from copier.pool import CommandFailed

    master, slave, engine, state, journal, rules, make = live
    link = make()
    slave.fail_always["open"] = CommandFailed("ORDER_REJECTED", '{"retcode": 10019, "comment": "No money"}')
    ticket = master.add("BTCUSD.c", "BUY", 0.01)
    for _ in range(4):
        engine.run_link(link)
        state.get(link.id).failures[ticket]["nextTry"] = 0  # retry now

    assert kinds(engine).count("error") == 1
    assert calls(slave, "open") == 4  # still retried, just not re-announced
