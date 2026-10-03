"""Refreshing the slave account, trade-mode checks, the test run, and the pool
surviving a terminal that cannot be started."""
from __future__ import annotations

from pathlib import Path

import pytest

from copier import pool as pool_module
from copier.engine import Engine, Link
from copier.pool import Account, Worker, WorkerDown
from copier.rules import CopyRules
from copier.state import StateStore
from copier.testrun import run_test
from test_engine import FakeAccount, FakePool, reader, terminal_master


@pytest.fixture
def setup(tmp_path: Path):
    master = FakeAccount(100003, ["XAUUSD.c", "EURUSD.c", "BTCUSD.c"], balance=6494.88)
    dest = FakeAccount(910102, ["XAUUSD.s", "EURUSD.s"], balance=22016.01)
    pool = FakePool({"m": master, "d": dest})
    state = StateStore(tmp_path / "state.json")
    engine = Engine(pool, state, reader(pool), poll_interval=0.01)

    def make_link(**overrides) -> Link:
        rules = CopyRules(**overrides.pop("rules", {}))
        options = {"enabled": True, "dry_run": False, **overrides}
        link = Link(id="L1", label="test", master=terminal_master("m"), dest_id="d",
                    rules=rules, **options)
        engine.set_links([link])
        return link

    return master, dest, engine, state, make_link


def kinds(engine: Engine) -> list[str]:
    return [e["kind"] for e in engine.events(500, since=0)]


def last(engine: Engine, kind: str) -> dict:
    return [e for e in engine.events(500, since=0) if e["kind"] == kind][-1]


def calls(account: FakeAccount, cmd: str) -> int:
    return sum(1 for name, _ in account.calls if name == cmd)


# -- refreshing the slave account -------------------------------------------

def test_a_symbol_the_broker_enabled_later_is_copied_after_a_refresh(setup):
    master, dest, engine, state, make_link = setup
    dest.after_login = ["BTCUSD.s"]
    link = make_link()
    engine.run_link(link)

    master.add("BTCUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert [p["symbol"] for p in dest.positions.values()] == ["BTCUSD.s"]
    assert calls(dest, "refresh") == 1
    opened = last(engine, "opened")
    assert opened["refresh"]["ok"] is True
    assert "skipped" not in kinds(engine)


def test_a_hand_mapped_symbol_the_terminal_does_not_know_yet_is_refreshed(setup):
    master, dest, engine, state, make_link = setup
    dest.after_login = ["BTCUSD.r"]
    link = make_link(rules={"symbol_map": {"BTCUSD.c": "BTCUSD.r"}})
    engine.run_link(link)

    master.add("BTCUSD.c", "SELL", 0.10)
    engine.run_link(link)

    assert [p["symbol"] for p in dest.positions.values()] == ["BTCUSD.r"]
    refresh_args = [args for name, args in dest.calls if name == "refresh"]
    assert refresh_args == [{"symbol": "BTCUSD.r"}]


def test_a_symbol_that_really_is_missing_is_reported_with_the_refresh(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"symbol_map": {"BTCUSD.c": "BTCUSD.r"}})
    engine.run_link(link)

    ticket = master.add("BTCUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert dest.positions == {}
    skipped = last(engine, "skipped")
    assert skipped["masterTicket"] == ticket
    assert skipped["masterSymbol"] == "BTCUSD.c"
    assert "BTCUSD.r is not tradable" in skipped["reason"]
    assert skipped["refresh"]["ok"] is True
    assert skipped["refresh"]["available"] is False


def test_the_slave_is_not_logged_in_again_on_every_retry(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"symbol_map": {"BTCUSD.c": "BTCUSD.r"}})
    engine.run_link(link)

    ticket = master.add("BTCUSD.c", "BUY", 0.10)
    for _ in range(4):
        state.get("L1").failures.get(ticket, {})["nextTry"] = 0  # retry now
        engine.run_link(link)

    assert calls(dest, "refresh") == 1
    assert kinds(engine).count("skipped") == 1


def test_a_failed_refresh_does_not_stop_the_link(setup):
    from copier.pool import CommandFailed

    master, dest, engine, state, make_link = setup
    link = make_link(rules={"symbol_map": {"BTCUSD.c": "BTCUSD.r"}})
    engine.run_link(link)
    dest.fail_on["refresh"] = CommandFailed("CONNECT_FAILED", "login failed")

    master.add("BTCUSD.c", "BUY", 0.10)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert [p["symbol"] for p in dest.positions.values()] == ["XAUUSD.s"]
    assert last(engine, "skipped")["refresh"]["ok"] is False


# -- trade modes ------------------------------------------------------------

def test_a_close_only_symbol_is_not_opened(setup):
    master, dest, engine, state, make_link = setup
    dest.trade_modes["XAUUSD.s"] = 3
    link = make_link()
    engine.run_link(link)

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert dest.positions == {}
    assert calls(dest, "open") == 0
    assert "close-only" in last(engine, "skipped")["reason"]


def test_a_buy_only_symbol_refuses_a_sell(setup):
    master, dest, engine, state, make_link = setup
    dest.trade_modes["XAUUSD.s"] = 1
    link = make_link()
    engine.run_link(link)

    master.add("XAUUSD.c", "SELL", 0.10)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    assert [p["side"] for p in dest.positions.values()] == ["BUY"]
    assert "only accepts BUY" in last(engine, "skipped")["reason"]


# -- the test run -----------------------------------------------------------

def test_a_test_run_checks_everything_and_places_no_order(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    master.add("XAUUSD.c", "BUY", 0.50, sl=95.0, tp=110.0)

    result = run_test(engine, link)

    assert result["ok"] is True
    statuses = {s["key"]: s["status"] for s in result["steps"]}
    assert statuses["master"] == "pass"
    assert statuses["slave"] == "pass"
    assert statuses["trading"] == "pass"
    assert statuses["link"] == "pass"
    assert statuses["symbol:XAUUSD.c"] == "pass"
    assert statuses["check:XAUUSD.s"] == "pass"
    assert calls(dest, "open") == 0
    assert calls(dest, "check") == 1
    check_args = next(args for name, args in dest.calls if name == "check")
    assert (check_args["sl"], check_args["tp"]) == (95.0, 110.0)


def test_a_test_run_leaves_the_link_state_alone(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    master.add("XAUUSD.c", "BUY", 0.50)
    before = state.get("L1").to_dict()

    run_test(engine, link)

    assert state.get("L1").to_dict() == before
    assert dest.positions == {}


def test_a_test_run_reports_an_order_the_broker_would_reject(setup):
    master, dest, engine, state, make_link = setup
    dest.margin_free = 0.0
    link = make_link()
    master.add("XAUUSD.c", "BUY", 0.50)

    result = run_test(engine, link)

    assert result["ok"] is False
    failed = [s for s in result["steps"] if s["status"] == "fail"]
    assert [s["key"] for s in failed] == ["check:XAUUSD.s"]
    assert "No money" in failed[0]["detail"]


def test_a_test_run_reports_a_slave_that_cannot_trade(setup):
    master, dest, engine, state, make_link = setup
    dest.trade_allowed = False
    link = make_link()

    result = run_test(engine, link)

    assert result["ok"] is False
    trading = next(s for s in result["steps"] if s["key"] == "trading")
    assert trading["status"] == "fail"


def test_a_test_run_warns_about_a_stopped_or_dry_run_link(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(enabled=False)
    assert next(s for s in run_test(engine, link)["steps"] if s["key"] == "link")["status"] == "warn"
    link = make_link(dry_run=True)
    assert next(s for s in run_test(engine, link)["steps"] if s["key"] == "link")["status"] == "warn"


def test_with_nothing_open_a_test_run_samples_a_common_instrument(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()

    result = run_test(engine, link)

    keys = [s["key"] for s in result["steps"]]
    assert "symbol:XAUUSD.c" in keys
    assert result["ok"] is True
    sized = next(s for s in result["steps"] if s["key"] == "symbol:XAUUSD.c")
    assert sized["sample"] == "common instrument"


def test_a_test_run_prefers_hand_mappings_when_nothing_is_open(setup):
    master, dest, engine, state, make_link = setup
    dest.symbols.append("BTCUSD.r")
    link = make_link(rules={"symbol_map": {"BTCUSD.c": "BTCUSD.r"}})

    result = run_test(engine, link)

    assert any(s["key"] == "check:BTCUSD.r" and s["status"] == "pass" for s in result["steps"])


def test_a_test_run_reports_an_unreachable_master(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    master.fail_on["snapshot"] = WorkerDown("master terminal is down")

    result = run_test(engine, link)

    assert result["ok"] is False
    assert result["steps"][0]["key"] == "master"
    assert result["steps"][0]["status"] == "fail"


# -- the pool ---------------------------------------------------------------

def test_a_terminal_that_cannot_be_set_up_backs_off_instead_of_spinning(tmp_path, monkeypatch):
    def broken(*_args, **_kwargs):
        raise FileNotFoundError("No MetaTrader 5 install found.")

    monkeypatch.setattr(pool_module.terminals, "provision", broken)
    worker = Worker(Account(id="d", label="slave", server="S", login=1, password="x"),
                    terminals_root=tmp_path)

    with pytest.raises(WorkerDown, match="could not start the terminal"):
        worker.start()
    assert "No MetaTrader 5 install" in (worker.last_error or "")
    with pytest.raises(WorkerDown, match="backing off"):
        worker.start()
