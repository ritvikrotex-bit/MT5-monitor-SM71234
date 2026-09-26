"""Symbol resolution and lot sizing — the logic that decides what gets traded."""
from __future__ import annotations

import pytest

from copier.engine import magic_for, parse_master_ticket
from copier.rules import CopyRules, RuleError, SymbolIndex, symbol_base

# The two real servers this was built against: TD Capital uses a ".c" suffix,
# Wyncrest uses ".s".
MASTER_SYMBOLS = ["XAUUSD.c", "EURUSD.c", "BTCUSD.c", "XAUUSD.ox", "EURUSD.testing"]
DEST = SymbolIndex(["XAUUSD.s", "EURUSD.s", "GBPUSD.s", "USDJPY.s"])

XAU_SPEC = {"volumeMin": 0.01, "volumeMax": 30.0, "volumeStep": 0.01, "digits": 2}


def test_symbol_base_strips_broker_decoration():
    assert symbol_base("XAUUSD.c") == "XAUUSD"
    assert symbol_base("EURUSD-ECN") == "EURUSD"
    assert symbol_base("GBPUSD_raw") == "GBPUSD"
    assert symbol_base("USDJPY") == "USDJPY"


def test_resolves_across_different_suffixes():
    rules = CopyRules()
    assert rules.resolve_symbol("XAUUSD.c", DEST) == "XAUUSD.s"
    assert rules.resolve_symbol("EURUSD.c", DEST) == "EURUSD.s"


def test_explicit_map_wins():
    rules = CopyRules(symbol_map={"XAUUSD.c": "GBPUSD.s"})
    assert rules.resolve_symbol("XAUUSD.c", DEST) == "GBPUSD.s"


def test_unmapped_symbol_is_an_error_not_a_guess():
    rules = CopyRules()
    with pytest.raises(RuleError, match="no symbol matching"):
        rules.resolve_symbol("BTCUSD.c", DEST)


def test_ambiguous_base_needs_a_suffix():
    index = SymbolIndex(["XAUUSD.s", "XAUUSD.pro"])
    with pytest.raises(RuleError, match="several destination symbols"):
        CopyRules().resolve_symbol("XAUUSD.c", index)
    assert CopyRules(symbol_suffix=".s").resolve_symbol("XAUUSD.c", index) == "XAUUSD.s"


def test_mapped_to_a_symbol_the_destination_lacks():
    rules = CopyRules(symbol_map={"XAUUSD.c": "XAUUSD.zz"})
    with pytest.raises(RuleError, match="does not offer"):
        rules.resolve_symbol("XAUUSD.c", DEST)


def test_allow_and_deny_lists_use_base_names():
    assert CopyRules(deny_symbols=["XAUUSD"]).symbol_allowed("XAUUSD.c") is False
    assert CopyRules(allow_symbols=["EURUSD"]).symbol_allowed("XAUUSD.c") is False
    assert CopyRules(allow_symbols=["EURUSD"]).symbol_allowed("EURUSD.c") is True
    assert CopyRules().symbol_allowed("ANYTHING.c") is True


# -- sizing ----------------------------------------------------------------

def test_multiplier_mode():
    rules = CopyRules(lot_mode="MULTIPLIER", lot_value=2.0)
    assert rules.scale_volume(0.5, master_balance=1000, dest_balance=1000) == 1.0


def test_fixed_mode_ignores_master_volume():
    rules = CopyRules(lot_mode="FIXED", lot_value=0.05)
    assert rules.scale_volume(7.0, master_balance=1000, dest_balance=1000) == 0.05


def test_balance_mode_scales_by_account_size():
    # the real pair: master 6,494.88 -> destination 22,016.01
    rules = CopyRules(lot_mode="BALANCE", lot_value=1.0)
    scaled = rules.scale_volume(0.10, master_balance=6494.88, dest_balance=22016.01)
    assert scaled == pytest.approx(0.339, abs=0.001)
    assert rules.round_volume(scaled, XAU_SPEC) == 0.33


def test_balance_mode_refuses_a_zero_master_balance():
    with pytest.raises(RuleError, match="master balance is zero"):
        CopyRules(lot_mode="BALANCE").scale_volume(0.1, master_balance=0, dest_balance=100)


def test_volume_rounds_down_so_exposure_never_grows():
    rules = CopyRules()
    assert rules.round_volume(0.379, XAU_SPEC) == 0.37
    assert rules.round_volume(0.3999, XAU_SPEC) == 0.39


def test_binary_float_dust_does_not_lose_a_step():
    # 0.3 / 0.1 is 2.9999999999999996 in binary floating point; a naive floor
    # would turn a clean 0.30 lot into 0.20.
    assert CopyRules().round_volume(0.3, {"volumeMin": 0.01, "volumeStep": 0.1}) == 0.3
    assert CopyRules().round_volume(0.07, {"volumeMin": 0.01, "volumeStep": 0.01}) == 0.07


def test_max_lot_caps_the_order():
    rules = CopyRules(max_lot=0.5)
    assert rules.round_volume(2.0, XAU_SPEC) == 0.5


def test_symbol_maximum_caps_the_order():
    assert CopyRules().round_volume(100.0, XAU_SPEC) == 30.0


def test_below_minimum_skips_by_default():
    rules = CopyRules(lot_mode="MULTIPLIER", lot_value=0.1)
    assert rules.round_volume(rules.scale_volume(0.05, master_balance=1, dest_balance=1), XAU_SPEC) == 0.0


def test_below_minimum_can_round_up_when_asked():
    rules = CopyRules(min_volume_action="MIN")
    assert rules.round_volume(0.004, XAU_SPEC) == 0.01


def test_min_volume_action_respects_max_lot():
    # asking for the minimum must not quietly exceed an explicit cap
    rules = CopyRules(min_volume_action="MIN", max_lot=0.005)
    assert rules.round_volume(0.004, XAU_SPEC) == 0.0


# -- direction and stops ---------------------------------------------------

def test_reverse_flips_the_side():
    assert CopyRules().side_for("BUY") == "BUY"
    assert CopyRules(reverse=True).side_for("BUY") == "SELL"
    assert CopyRules(reverse=True).side_for("SELL") == "BUY"


def test_stops_are_copied_as_absolute_prices():
    assert CopyRules().stops_for(1950.5, 1975.0) == (1950.5, 1975.0)


def test_stops_are_dropped_when_reversing():
    # the master's levels sit on the wrong side of the price once reversed
    assert CopyRules(reverse=True).stops_for(1950.5, 1975.0) == (0.0, 0.0)


def test_stops_are_dropped_when_disabled():
    assert CopyRules(copy_sl_tp=False).stops_for(1950.5, 1975.0) == (0.0, 0.0)


# -- validation ------------------------------------------------------------

def test_bad_configuration_is_refused_up_front():
    with pytest.raises(ValueError, match="lot_mode"):
        CopyRules(lot_mode="MAGIC")
    with pytest.raises(ValueError, match="lot_value"):
        CopyRules(lot_value=0)
    with pytest.raises(ValueError, match="min_volume_action"):
        CopyRules(min_volume_action="WHATEVER")


# -- ownership tagging -----------------------------------------------------

def test_master_ticket_round_trips_through_the_comment():
    assert parse_master_ticket("c123456789") == 123456789
    assert parse_master_ticket("") is None
    assert parse_master_ticket("some broker note") is None


def test_magic_is_stable_per_link_and_distinct_between_links():
    assert magic_for("link-a") == magic_for("link-a")
    assert magic_for("link-a") != magic_for("link-b")
    assert 0 < magic_for("link-a") < 2**31
