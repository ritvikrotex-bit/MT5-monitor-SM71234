"""Reconciliation tests against a simulated pair of accounts.

These cover the failure modes that actually cost money in a copier: copying a
trade twice, missing a close, re-copying everything after a restart, and
touching positions that belong to somebody else.
"""
from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from copier.engine import Engine, Link
from copier.pool import CommandFailed, WorkerDown
from copier.rules import CopyRules
from copier.sources import MasterReader, TerminalMaster
from copier.state import StateStore

SPEC = {"symbol": "", "digits": 2, "volumeMin": 0.01, "volumeMax": 30.0,
        "volumeStep": 0.01, "stopsLevel": 10, "point": 0.01, "tradeMode": 4}


class FakeAccount:
    """A minimal stand-in for one MT5 account."""

    def __init__(self, login: int, symbols: list[str], *, balance: float = 10_000.0,
                 hedging: bool = True, trade_allowed: bool = True) -> None:
        self.login = login
        self.symbols = symbols
        self.balance = balance
        self.equity = balance
        self.hedging = hedging
        self.trade_allowed = trade_allowed
        self.positions: dict[int, dict] = {}
        self.tickets = itertools.count(1000 + login)
        self.calls: list[tuple[str, dict]] = []
        self.fail_on: dict[str, Exception] = {}

    def add(self, symbol: str, side: str, volume: float, *, sl: float = 0.0, tp: float = 0.0,
            magic: int = 0, comment: str = "", ticket: int | None = None) -> int:
        ticket = ticket if ticket is not None else next(self.tickets)
        self.positions[ticket] = {
            "ticket": ticket, "symbol": symbol, "side": side, "volume": volume,
            "priceOpen": 100.0, "priceCurrent": 100.0, "sl": sl, "tp": tp,
            "profit": 0.0, "swap": 0.0, "magic": magic, "comment": comment, "openedAt": ticket,
        }
        return ticket

    # -- worker protocol ---------------------------------------------------

    def call(self, cmd: str, args: dict | None = None, *, timeout: float = 0) -> dict:
        args = args or {}
        self.calls.append((cmd, args))
        error = self.fail_on.pop(cmd, None)
        if error is not None:
            raise error

        if cmd == "snapshot":
            return {
                "account": {
                    "login": self.login, "name": f"acct {self.login}", "server": "Test",
                    "company": "Test", "currency": "USD", "balance": self.balance,
                    "equity": self.equity, "margin": 0.0, "marginFree": self.balance,
                    "leverage": 500, "hedging": self.hedging, "tradeMode": 0,
                    "tradeAllowed": self.trade_allowed,
                },
                "positions": [dict(p) for p in self.positions.values()],
                "at": 0.0,
            }
        if cmd == "symbols":
            return {"symbols": list(self.symbols)}
        if cmd == "spec":
            return {**SPEC, "symbol": args["symbol"]}
        if cmd == "open":
            ticket = self.add(
                args["symbol"], args["side"], args["volume"],
                sl=args.get("sl") or 0.0, tp=args.get("tp") or 0.0,
                magic=args.get("magic", 0), comment=args.get("comment", ""),
            )
            return {"retcode": 10009, "order": ticket, "deal": ticket,
                    "volume": args["volume"], "price": 100.0, "comment": ""}
        if cmd == "close":
            ticket = int(args["ticket"])
            position = self.positions.get(ticket)
            if position is None:
                return {"retcode": 10009, "alreadyClosed": True, "comment": ""}
            volume = float(args.get("volume") or position["volume"])
            if volume >= position["volume"]:
                del self.positions[ticket]
            else:
                position["volume"] = round(position["volume"] - volume, 8)
            return {"retcode": 10009, "order": ticket, "deal": ticket, "volume": volume,
                    "price": 100.0, "comment": ""}
        if cmd == "modify":
            position = self.positions.get(int(args["ticket"]))
            if position is None:
                return {"retcode": 10009, "alreadyClosed": True, "comment": ""}
            position["sl"] = float(args.get("sl") or 0.0)
            position["tp"] = float(args.get("tp") or 0.0)
            return {"retcode": 10009, "comment": ""}
        raise AssertionError(f"unexpected command {cmd}")


class FakePool:
    def __init__(self, accounts: dict[str, FakeAccount]) -> None:
        self.accounts = accounts

    def get(self, account_id: str) -> FakeAccount:
        account = self.accounts.get(account_id)
        if account is None:
            raise WorkerDown(f"no worker for {account_id}")
        return account

    def statuses(self) -> dict:
        return {k: {"running": True} for k in self.accounts}


def reader(pool: FakePool) -> MasterReader:
    return MasterReader(None, pool)


def terminal_master(account_id: str) -> TerminalMaster:
    return TerminalMaster(label=account_id, account_id=account_id)


@pytest.fixture
def setup(tmp_path: Path):
    master = FakeAccount(100003, ["XAUUSD.c", "EURUSD.c", "BTCUSD.c"], balance=6494.88)
    dest = FakeAccount(910102, ["XAUUSD.s", "EURUSD.s"], balance=22016.01)
    pool = FakePool({"m": master, "d": dest})
    state = StateStore(tmp_path / "state.json")
    engine = Engine(pool, state, reader(pool), poll_interval=0.01)

    def make_link(**overrides) -> Link:
        rules = CopyRules(**overrides.pop("rules", {}))
        link = Link(id="L1", label="test", master=terminal_master("m"), dest_id="d",
                    rules=rules, enabled=True, dry_run=False, **overrides)
        engine.set_links([link])
        return link

    return master, dest, engine, state, make_link


# -- the basics ------------------------------------------------------------

def test_a_new_master_trade_is_copied_once(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)  # seeds: nothing open yet

    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1
    copied = next(iter(dest.positions.values()))
    assert copied["symbol"] == "XAUUSD.s"
    assert copied["side"] == "BUY"
    assert copied["comment"] == f"c{ticket}"
    assert copied["magic"] == link.magic

    # running again must not open a second one
    for _ in range(3):
        engine.run_link(link)
    assert len(dest.positions) == 1


def test_closing_on_the_master_closes_the_copy(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1

    del master.positions[ticket]
    engine.run_link(link)
    assert dest.positions == {}
    assert state.get("L1").mapping == {}


def test_a_partial_close_on_the_master_trims_the_copy(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"lot_mode": "MULTIPLIER", "lot_value": 1.0})
    engine.run_link(link)
    ticket = master.add("XAUUSD.c", "BUY", 1.00)
    engine.run_link(link)
    assert next(iter(dest.positions.values()))["volume"] == 1.00

    master.positions[ticket]["volume"] = 0.40
    engine.run_link(link)
    assert next(iter(dest.positions.values()))["volume"] == pytest.approx(0.40)


def test_moving_the_stops_on_the_master_moves_them_on_the_copy(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    master.positions[ticket]["sl"] = 1950.50
    master.positions[ticket]["tp"] = 1975.00
    engine.run_link(link)
    copied = next(iter(dest.positions.values()))
    assert (copied["sl"], copied["tp"]) == (1950.50, 1975.00)

    # and it settles: no further modify calls once they match
    before = sum(1 for c, _ in dest.calls if c == "modify")
    engine.run_link(link)
    assert sum(1 for c, _ in dest.calls if c == "modify") == before


# -- sizing and direction --------------------------------------------------

def test_balance_scaling_uses_both_account_sizes(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"lot_mode": "BALANCE", "lot_value": 1.0})
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    # 0.10 * 22016.01/6494.88 = 0.339 -> rounds down to 0.33
    assert next(iter(dest.positions.values()))["volume"] == 0.33


def test_reverse_mode_flips_the_side_and_drops_the_stops(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"reverse": True})
    engine.run_link(link)
    master.add("XAUUSD.c", "SELL", 0.10, sl=1990.0, tp=1900.0)
    engine.run_link(link)
    copied = next(iter(dest.positions.values()))
    assert copied["side"] == "BUY"
    assert (copied["sl"], copied["tp"]) == (0.0, 0.0)


# -- restart safety --------------------------------------------------------

def test_a_restart_does_not_re_copy_open_trades(setup, tmp_path):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1

    # restart: brand new engine and state store reading the same file
    fresh_pool = FakePool({"m": master, "d": dest})
    fresh_state = StateStore(state.path)
    fresh = Engine(fresh_pool, fresh_state, reader(fresh_pool), poll_interval=0.01)
    fresh.set_links([link])
    fresh.run_link(link)
    assert len(dest.positions) == 1


def test_mapping_is_rebuilt_from_comments_when_the_state_file_is_lost(setup, tmp_path):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master_ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)

    # lose the state file entirely
    state.path.unlink()
    fresh_pool = FakePool({"m": master, "d": dest})
    fresh_state = StateStore(state.path)
    fresh = Engine(fresh_pool, fresh_state, reader(fresh_pool), poll_interval=0.01)
    fresh.set_links([link])
    fresh.run_link(link)

    assert len(dest.positions) == 1, "the copy was duplicated after losing state"
    assert fresh_state.get("L1").mapping == {master_ticket: next(iter(dest.positions))}


def test_a_duplicate_copy_is_closed(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master_ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    # simulate a double-open that slipped through
    dest.add("XAUUSD.s", "BUY", 0.10, magic=link.magic, comment=f"c{master_ticket}")
    assert len(dest.positions) == 2

    engine.run_link(link)
    assert len(dest.positions) == 1


# -- not ours --------------------------------------------------------------

def test_positions_without_our_magic_are_never_touched(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    manual = dest.add("EURUSD.s", "SELL", 5.0, magic=0, comment="placed by hand")
    other_link = dest.add("EURUSD.s", "BUY", 3.0, magic=0x5C00AAAA, comment="c999999")
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    del master.positions[next(iter(master.positions))]
    engine.run_link(link)

    assert manual in dest.positions
    assert other_link in dest.positions
    assert dest.positions[manual]["volume"] == 5.0


def test_trades_already_open_on_the_master_are_ignored_by_default(setup):
    master, dest, engine, state, make_link = setup
    master.add("XAUUSD.c", "BUY", 0.10)
    master.add("EURUSD.c", "SELL", 0.20)
    link = make_link()
    engine.run_link(link)
    assert dest.positions == {}
    assert len(state.get("L1").ignored) == 2

    # a new trade after the link started is still copied
    master.add("XAUUSD.c", "BUY", 0.05)
    engine.run_link(link)
    assert len(dest.positions) == 1


def test_existing_trades_are_copied_when_asked(setup):
    master, dest, engine, state, make_link = setup
    master.add("XAUUSD.c", "BUY", 0.10)
    link = make_link(rules={"copy_existing": True})
    engine.run_link(link)
    assert len(dest.positions) == 1


# -- guards ----------------------------------------------------------------

def test_dry_run_sends_nothing(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    link.dry_run = True
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert dest.positions == {}
    assert any(e["kind"] == "open" for e in engine.events())


def test_an_unmapped_symbol_is_skipped_not_guessed(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master.add("BTCUSD.c", "BUY", 0.10)  # destination has no BTCUSD
    engine.run_link(link)
    assert dest.positions == {}
    assert any(e["kind"] == "skipped" for e in engine.events())


def test_a_failed_open_is_not_retried_on_every_cycle(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    dest.fail_on["open"] = CommandFailed("ORDER_REJECTED", "no money")
    engine.run_link(link)
    assert dest.positions == {}

    opens_before = sum(1 for c, _ in dest.calls if c == "open")
    for _ in range(5):
        engine.run_link(link)
    assert sum(1 for c, _ in dest.calls if c == "open") == opens_before, "hammered the broker"


def test_the_position_cap_is_respected(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(rules={"max_open_positions": 2})
    engine.run_link(link)
    for _ in range(4):
        master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 2


def test_a_netting_destination_halts_the_link(setup):
    master, dest, engine, state, make_link = setup
    dest.hedging = False  # the master's own mode is irrelevant
    link = make_link()
    engine.run_link(link)
    assert state.get("L1").halted_reason is not None
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert dest.positions == {}


def test_a_destination_that_cannot_trade_halts_the_link(setup):
    master, dest, engine, state, make_link = setup
    dest.trade_allowed = False
    link = make_link()
    engine.run_link(link)
    assert "not allowed to trade" in (state.get("L1").halted_reason or "")


def test_the_drawdown_guard_flattens_and_halts(setup):
    master, dest, engine, state, make_link = setup
    link = make_link(max_drawdown_pct=10.0)
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1

    dest.equity = dest.balance * 0.85  # down 15%
    engine.run_link(link)
    assert dest.positions == {}, "the drawdown guard left positions open"
    assert "past the 10.00% limit" in (state.get("L1").halted_reason or "")


def test_arming_clears_a_halt(setup):
    master, dest, engine, state, make_link = setup
    dest.trade_allowed = False
    link = make_link()
    engine.run_link(link)
    assert state.get("L1").halted_reason

    dest.trade_allowed = True
    engine.arm("L1")
    engine.run_link(link)          # re-seeds; halt is gone
    assert state.get("L1").halted_reason is None

    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1


# -- several masters and destinations --------------------------------------

def test_two_links_onto_one_destination_stay_separate(tmp_path):
    master_a = FakeAccount(1, ["XAUUSD.c"], balance=10_000)
    master_b = FakeAccount(2, ["XAUUSD.c"], balance=10_000)
    dest = FakeAccount(3, ["XAUUSD.s"], balance=10_000)
    pool = FakePool({"a": master_a, "b": master_b, "d": dest})
    engine = Engine(pool, StateStore(tmp_path / "s.json"), reader(pool), poll_interval=0.01)
    link_a = Link(id="A", label="A", master=terminal_master("a"), dest_id="d",
                  enabled=True, dry_run=False)
    link_b = Link(id="B", label="B", master=terminal_master("b"), dest_id="d",
                  enabled=True, dry_run=False)
    engine.set_links([link_a, link_b])
    assert link_a.magic != link_b.magic

    for link in (link_a, link_b):
        engine.run_link(link)
    master_a.add("XAUUSD.c", "BUY", 0.10)
    master_b.add("XAUUSD.c", "SELL", 0.20)
    for link in (link_a, link_b):
        engine.run_link(link)
    assert len(dest.positions) == 2

    # closing on master A must leave master B's copy alone
    master_a.positions.clear()
    for link in (link_a, link_b):
        engine.run_link(link)
    assert len(dest.positions) == 1
    assert next(iter(dest.positions.values()))["magic"] == link_b.magic


def test_one_master_fanned_out_to_two_destinations(tmp_path):
    master = FakeAccount(1, ["XAUUSD.c"], balance=10_000)
    dest_a = FakeAccount(2, ["XAUUSD.s"], balance=10_000)
    dest_b = FakeAccount(3, ["XAUUSD.s"], balance=20_000)
    pool = FakePool({"m": master, "a": dest_a, "b": dest_b})
    engine = Engine(pool, StateStore(tmp_path / "s.json"), reader(pool), poll_interval=0.01)
    link_a = Link(id="A", label="A", master=terminal_master("m"), dest_id="a",
                  enabled=True, dry_run=False,
                  rules=CopyRules(lot_mode="MULTIPLIER", lot_value=1.0))
    link_b = Link(id="B", label="B", master=terminal_master("m"), dest_id="b",
                  enabled=True, dry_run=False,
                  rules=CopyRules(lot_mode="MULTIPLIER", lot_value=2.0))
    engine.set_links([link_a, link_b])
    for link in (link_a, link_b):
        engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    for link in (link_a, link_b):
        engine.run_link(link)

    assert next(iter(dest_a.positions.values()))["volume"] == 0.10
    assert next(iter(dest_b.positions.values()))["volume"] == 0.20


def test_arming_after_a_drawdown_halt_does_not_re_enter_the_losing_trades(setup):
    """The guard fired for a reason: resuming must not pile straight back in.

    After a halt the master is usually still holding the trades that caused the
    loss. Arming resumes from the current moment, so those are left alone and
    only genuinely new master trades are copied.
    """
    master, dest, engine, state, make_link = setup
    link = make_link(max_drawdown_pct=10.0)
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    master.add("EURUSD.c", "SELL", 0.20)
    engine.run_link(link)
    assert len(dest.positions) == 2

    dest.equity = dest.balance * 0.85
    engine.run_link(link)
    assert dest.positions == {}

    dest.equity = dest.balance
    engine.arm("L1")
    engine.run_link(link)
    assert dest.positions == {}, "arming re-entered the trades that caused the drawdown"

    master.add("XAUUSD.c", "BUY", 0.05)
    engine.run_link(link)
    assert len(dest.positions) == 1


def test_arming_keeps_managing_positions_the_link_still_owns(setup):
    """Arming resets seeding, but must not orphan live copies."""
    master, dest, engine, state, make_link = setup
    link = make_link()
    engine.run_link(link)
    master_ticket = master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)
    assert len(dest.positions) == 1

    engine.arm("L1")
    engine.run_link(link)
    assert len(dest.positions) == 1, "the live copy was abandoned"
    assert state.get("L1").mapping.get(master_ticket)

    del master.positions[master_ticket]
    engine.run_link(link)
    assert dest.positions == {}, "the copy was not closed with its master"
