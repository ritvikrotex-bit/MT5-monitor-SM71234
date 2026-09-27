"""The translation preview: what a link would do with each master symbol.

This exists because "why did that trade not copy?" should be answerable before
a trade depends on the answer, not after.
"""
from __future__ import annotations

from copier.rules import (
    PREVIEW_AMBIGUOUS,
    PREVIEW_AUTO,
    PREVIEW_BLOCKED,
    PREVIEW_MANUAL,
    PREVIEW_UNMATCHED,
    CopyRules,
    SymbolIndex,
    preview_translation,
)

# The real pair: TD Capital uses ".c", Wyncrest uses ".s" and carries no indices.
MASTER = ["EURUSD.c", "XAUUSD.c", "BTCUSD.c", "AAPL.c"]
DEST = SymbolIndex(["EURUSD.s", "XAUUSD.s", "BTCUSD.s", "GBPUSD.s"])


def by_source(rows):
    return {r["source"]: r for r in rows}


def test_a_plain_suffix_swap_is_automatic():
    rows = by_source(preview_translation(CopyRules(), MASTER, DEST))
    assert rows["EURUSD.c"]["status"] == PREVIEW_AUTO
    assert rows["EURUSD.c"]["destination"] == "EURUSD.s"
    assert "EURUSD" in rows["EURUSD.c"]["detail"]


def test_a_hand_mapping_is_reported_as_manual():
    rules = CopyRules(symbol_map={"BTCUSD.c": "BTCUSD.s"})
    rows = by_source(preview_translation(rules, MASTER, DEST))
    assert rows["BTCUSD.c"]["status"] == PREVIEW_MANUAL
    assert rows["BTCUSD.c"]["destination"] == "BTCUSD.s"


def test_a_symbol_with_no_counterpart_is_unmatched():
    rows = by_source(preview_translation(CopyRules(), MASTER, DEST))
    assert rows["AAPL.c"]["status"] == PREVIEW_UNMATCHED
    assert rows["AAPL.c"]["destination"] is None


def test_an_allow_list_shows_what_it_excludes():
    """The live failure, made visible before it costs a trade."""
    rules = CopyRules(allow_symbols=["EURUSD"])
    rows = by_source(preview_translation(rules, MASTER, DEST))
    assert rows["EURUSD.c"]["status"] == PREVIEW_AUTO
    assert rows["BTCUSD.c"]["status"] == PREVIEW_BLOCKED
    assert "only EURUSD" in rows["BTCUSD.c"]["detail"]


def test_a_blocked_symbol_says_which_list_stopped_it():
    rules = CopyRules(deny_symbols=["BTCUSD"])
    rows = by_source(preview_translation(rules, MASTER, DEST))
    assert rows["BTCUSD.c"]["status"] == PREVIEW_BLOCKED
    assert "blocked list" in rows["BTCUSD.c"]["detail"]


def test_blocking_wins_over_a_hand_mapping():
    rules = CopyRules(symbol_map={"BTCUSD.c": "BTCUSD.s"}, deny_symbols=["BTCUSD"])
    rows = by_source(preview_translation(rules, MASTER, DEST))
    assert rows["BTCUSD.c"]["status"] == PREVIEW_BLOCKED


def test_an_ambiguous_base_is_distinguished_from_no_match():
    index = SymbolIndex(["XAUUSD.s", "XAUUSD.pro"])
    rows = by_source(preview_translation(CopyRules(), ["XAUUSD.c"], index))
    assert rows["XAUUSD.c"]["status"] == PREVIEW_AMBIGUOUS
    rows = by_source(preview_translation(CopyRules(symbol_suffix=".s"), ["XAUUSD.c"], index))
    assert rows["XAUUSD.c"]["status"] == PREVIEW_AUTO


def test_a_mapping_the_destination_has_not_listed_is_still_shown_as_manual():
    """The stale-symbol-list case: trust the mapping, flag that it is unconfirmed."""
    rules = CopyRules(symbol_map={"BTCUSD.c": "BTCUSD.s"})
    thin = SymbolIndex(["EURUSD.s"])  # terminal has not pulled BTCUSD.s in yet
    rows = by_source(preview_translation(rules, ["BTCUSD.c"], thin))
    assert rows["BTCUSD.c"]["status"] == PREVIEW_MANUAL
    assert rows["BTCUSD.c"]["destination"] == "BTCUSD.s"
    assert "not listed this symbol yet" in rows["BTCUSD.c"]["detail"]


def test_every_master_symbol_gets_exactly_one_row():
    rows = preview_translation(CopyRules(), MASTER, DEST)
    assert len(rows) == len(MASTER)
    assert {r["source"] for r in rows} == set(MASTER)


def test_turning_off_base_matching_leaves_only_hand_mappings():
    """For brokers whose naming does not line up, a wrong automatic match would
    trade the wrong instrument. Turning it off makes mappings the only route."""
    rules = CopyRules(auto_match=False, symbol_map={"EURUSD.c": "EURUSD.s"})
    rows = by_source(preview_translation(rules, MASTER, DEST))
    assert rows["EURUSD.c"]["status"] == PREVIEW_MANUAL
    assert rows["XAUUSD.c"]["status"] == PREVIEW_UNMATCHED
    assert "matching by base name is turned off" in rows["XAUUSD.c"]["detail"]
