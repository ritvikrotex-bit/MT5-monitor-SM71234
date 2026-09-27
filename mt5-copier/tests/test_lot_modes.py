"""Every lot mode, end to end through the engine, against a simulated pair.

The sizing maths has unit coverage in test_rules.py. This file checks the part
that actually costs money: what volume reaches the broker for each mode, and
that a trade is never dropped without saying why.

The accounts mirror the real pair this was built against — master TDFX 100003
at 6,684.25 and destination Wyncrest 910102 at 22,014.97, a ratio of ~3.29.
"""
from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from copier.engine import Engine, Link
from copier.rules import CopyRules
from copier.sources import MasterReader, TerminalMaster
from copier.state import StateStore
from tests.test_engine import FakeAccount, FakePool

MASTER_BALANCE = 6684.25
DEST_BALANCE = 22014.97
RATIO = DEST_BALANCE / MASTER_BALANCE  # ~3.293


_run = itertools.count()


def build(tmp_path: Path, **rule_overrides):
    master = FakeAccount(100003, ["BTCUSD.c", "XAUUSD.c", "EURUSD.c"], balance=MASTER_BALANCE)
    dest = FakeAccount(910102, ["BTCUSD.s", "XAUUSD.s", "EURUSD.s"], balance=DEST_BALANCE)
    pool = FakePool({"m": master, "d": dest})
    # A fresh state file per build: tests that size the same trade twice must
    # not inherit the first attempt's retry backoff.
    store = StateStore(tmp_path / f"s{next(_run)}.json")
    engine = Engine(pool, store, MasterReader(None, pool), poll_interval=0.01)
    link = Link(
        id="L",
        label="lot mode",
        master=TerminalMaster(label="m", account_id="m"),
        dest_id="d",
        rules=CopyRules(**rule_overrides),
        enabled=True,
        dry_run=False,
    )
    engine.set_links([link])
    engine.run_link(link)  # seed against an empty master
    return master, dest, engine, store, link


def copy_one(tmp_path: Path, master_volume: float, **rules) -> float | None:
    """Place one master trade and return the copied volume, or None if skipped."""
    master, dest, engine, store, link = build(tmp_path, **rules)
    master.add("BTCUSD.c", "BUY", master_volume)
    engine.run_link(link)
    if not dest.positions:
        return None
    return float(next(iter(dest.positions.values()))["volume"])


# -- FIXED -----------------------------------------------------------------

def test_fixed_ignores_the_master_volume(tmp_path):
    assert copy_one(tmp_path, 0.01, lot_mode="FIXED", lot_value=0.05) == 0.05
    assert copy_one(tmp_path, 5.00, lot_mode="FIXED", lot_value=0.05) == 0.05


def test_fixed_is_still_capped_by_max_lot(tmp_path):
    assert copy_one(tmp_path, 1.0, lot_mode="FIXED", lot_value=0.50, max_lot=0.10) == 0.10


# -- MULTIPLIER ------------------------------------------------------------

def test_multiplier_scales_the_master_volume(tmp_path):
    assert copy_one(tmp_path, 0.10, lot_mode="MULTIPLIER", lot_value=2.0) == 0.20
    assert copy_one(tmp_path, 0.10, lot_mode="MULTIPLIER", lot_value=0.5) == 0.05


def test_multiplier_below_the_minimum_is_skipped_by_default(tmp_path):
    # 0.01 x 0.5 = 0.005, under the 0.01 minimum
    assert copy_one(tmp_path, 0.01, lot_mode="MULTIPLIER", lot_value=0.5) is None


def test_multiplier_below_the_minimum_can_use_the_minimum(tmp_path):
    assert (
        copy_one(tmp_path, 0.01, lot_mode="MULTIPLIER", lot_value=0.5, min_volume_action="MIN")
        == 0.01
    )


# -- BALANCE ---------------------------------------------------------------

def test_balance_scales_by_the_account_ratio(tmp_path):
    # 0.10 x 3.293 = 0.329 -> rounds down to 0.32
    assert copy_one(tmp_path, 0.10, lot_mode="BALANCE", lot_value=1.0) == 0.32


def test_balance_with_a_factor(tmp_path):
    # 1.00 x 3.293 x 0.10 = 0.329 -> 0.32
    assert copy_one(tmp_path, 1.00, lot_mode="BALANCE", lot_value=0.10) == 0.32


def test_balance_with_a_tiny_factor_falls_under_the_minimum(tmp_path):
    """The exact setup that stopped copies on the live link.

    0.01 x 3.293 x 0.01 = 0.00033 lots, far below the 0.01 minimum.
    """
    assert copy_one(tmp_path, 0.01, lot_mode="BALANCE", lot_value=0.01) is None
    assert (
        copy_one(tmp_path, 0.01, lot_mode="BALANCE", lot_value=0.01, min_volume_action="MIN")
        == 0.01
    )


def test_balance_respects_max_lot(tmp_path):
    assert copy_one(tmp_path, 1.00, lot_mode="BALANCE", lot_value=1.0, max_lot=0.50) == 0.50


# -- EQUITY ----------------------------------------------------------------

def test_equity_scales_by_the_equity_ratio(tmp_path):
    master, dest, engine, store, link = build(tmp_path, lot_mode="EQUITY", lot_value=1.0)
    master.equity = 3342.0  # half the balance
    dest.equity = 22014.97
    master.add("BTCUSD.c", "BUY", 0.10)
    engine.run_link(link)
    # 0.10 x (22014.97 / 3342.0) = 0.658 -> 0.65
    assert float(next(iter(dest.positions.values()))["volume"]) == 0.65


def test_equity_with_a_tiny_factor_falls_under_the_minimum(tmp_path):
    assert copy_one(tmp_path, 0.01, lot_mode="EQUITY", lot_value=0.01) is None


def test_equity_uses_the_minimum_when_asked(tmp_path):
    assert (
        copy_one(tmp_path, 0.01, lot_mode="EQUITY", lot_value=0.01, min_volume_action="MIN")
        == 0.01
    )


# -- every mode, one table -------------------------------------------------

@pytest.mark.parametrize(
    "mode,value,master_volume,expected",
    [
        ("FIXED", 0.01, 0.05, 0.01),
        ("FIXED", 0.10, 0.05, 0.10),
        ("MULTIPLIER", 1.0, 0.05, 0.05),
        ("MULTIPLIER", 3.0, 0.05, 0.15),
        ("BALANCE", 1.0, 0.05, 0.16),   # 0.05 x 3.293 = 0.1646 -> 0.16
        ("EQUITY", 1.0, 0.05, 0.16),    # equity equals balance here
    ],
)
def test_each_mode_places_the_expected_volume(tmp_path, mode, value, master_volume, expected):
    assert copy_one(tmp_path, master_volume, lot_mode=mode, lot_value=value) == expected


@pytest.mark.parametrize("mode", ["FIXED", "MULTIPLIER", "BALANCE", "EQUITY"])
def test_no_mode_ever_rounds_up(tmp_path, mode):
    """Rounding must never increase exposure, whatever the mode."""
    volume = copy_one(tmp_path, 0.07, lot_mode=mode, lot_value=0.333)
    if volume is None:
        return
    step = 0.01
    assert abs(round(volume / step) * step - volume) < 1e-9, "not on the lot grid"


# -- a filtered trade must explain itself ----------------------------------

def test_an_allow_list_that_excludes_the_symbol_says_so(tmp_path):
    """The live failure: allowSymbols was ["EURUSD"], so every BTCUSD trade was
    dropped. Silently, which looked exactly like a broken copier."""
    master, dest, engine, store, link = build(
        tmp_path, lot_mode="FIXED", lot_value=0.01, allow_symbols=["EURUSD"]
    )
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    assert dest.positions == {}
    events = [e for e in engine.events() if e["kind"] == "filtered"]
    assert len(events) == 1, "a filtered trade left no trace"
    assert "only EURUSD" in events[0]["message"]
    assert "BTCUSD" in events[0]["message"]


def test_a_blocked_symbol_says_so(tmp_path):
    master, dest, engine, store, link = build(
        tmp_path, lot_mode="FIXED", lot_value=0.01, deny_symbols=["BTCUSD"]
    )
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)

    assert dest.positions == {}
    [event] = [e for e in engine.events() if e["kind"] == "filtered"]
    assert "blocked list" in event["message"]


def test_an_allow_list_that_includes_the_symbol_copies_it(tmp_path):
    master, dest, engine, store, link = build(
        tmp_path, lot_mode="FIXED", lot_value=0.01, allow_symbols=["BTCUSD", "EURUSD"]
    )
    master.add("BTCUSD.c", "BUY", 0.01)
    engine.run_link(link)
    assert len(dest.positions) == 1
