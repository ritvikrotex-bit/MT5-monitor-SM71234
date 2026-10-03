"""Per-link copy rules: which symbol on the destination, and what lot size.

Brokers rarely agree on symbol names ("XAUUSD.c" on one server, "XAUUSD.s" on
another) or on account size, so every link carries a :class:`CopyRules` that
translates a master position into a destination order.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# Trailing broker decoration: ".c", "-ECN", "_raw", "m", "#" and friends.
_SUFFIX_RE = re.compile(r"^(?P<base>[A-Za-z0-9]+?)(?P<suffix>[._#-].*)?$")


class RuleError(Exception):
    """The rules cannot produce a valid order (unmapped symbol, zero lot, ...)."""


def symbol_base(name: str) -> str:
    """Strip broker decoration: 'XAUUSD.c' -> 'XAUUSD', 'EURUSD-ECN' -> 'EURUSD'."""
    match = _SUFFIX_RE.match(name.strip())
    return (match.group("base") if match else name).upper()


class SymbolIndex:
    """Destination symbols, indexed by their undecorated base name."""

    def __init__(self, symbols: Iterable[str]) -> None:
        self.all: list[str] = list(symbols)
        self._by_base: dict[str, list[str]] = {}
        for name in self.all:
            self._by_base.setdefault(symbol_base(name), []).append(name)
        self._exact = {name.upper(): name for name in self.all}

    def exact(self, name: str) -> str | None:
        return self._exact.get(name.upper())

    def by_base(self, base: str) -> list[str]:
        return self._by_base.get(base.upper(), [])


LOT_MODES = ("FIXED", "MULTIPLIER", "BALANCE", "EQUITY", "EQUITY_STEP", "RISK_PERCENT")
MIN_VOLUME_ACTIONS = ("SKIP", "MIN")
# MASTER: the copy follows the master's stop loss and take profit.
# TRAILING: the slave manages its own exit by trailing its profit; the master's
# levels are not copied, so the two exit rules can never fight each other.
EXIT_MODES = ("MASTER", "TRAILING")

_HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def parse_hhmm(value: str) -> int | None:
    """'09:30' -> 570 minutes after midnight; '' -> None."""
    value = (value or "").strip()
    if not value:
        return None
    match = _HHMM_RE.match(value)
    if not match:
        raise ValueError(f"times must look like 09:00, got {value!r}")
    return int(match.group(1)) * 60 + int(match.group(2))


@dataclass
class CopyRules:
    """How one master's trades become one destination's trades."""

    # --- symbols
    symbol_map: dict[str, str] = field(default_factory=dict)
    """Explicit master symbol -> destination symbol. Wins over everything else."""
    symbol_suffix: str = ""
    """Preferred destination suffix when a base name matches several symbols."""
    auto_match: bool = True
    """Match by undecorated base name. Turn it off to copy only what is mapped
    by hand, which is the safe choice when the two brokers' naming does not line
    up and a wrong match would trade the wrong instrument."""
    allow_symbols: list[str] = field(default_factory=list)
    """Base names to copy. Empty means all."""
    deny_symbols: list[str] = field(default_factory=list)
    """Base names never to copy."""

    # --- sizing
    lot_mode: str = "MULTIPLIER"
    lot_value: float = 1.0
    """FIXED: the lot itself. EQUITY_STEP: lots per ``equity_step``.
    RISK_PERCENT: percent of equity to lose if the master's stop loss is hit.
    Otherwise a factor applied to the scaled volume."""
    equity_step: float = 1000.0
    """EQUITY_STEP: ``lot_value`` lots for every this much destination equity."""
    max_lot: float = 0.0
    """Hard cap per order. 0 disables."""
    min_volume_action: str = "SKIP"
    """What to do when the computed lot is under the symbol minimum."""

    # --- behaviour
    reverse: bool = False
    copy_sl: bool = True
    copy_tp: bool = True
    copy_existing: bool = False
    """Copy positions already open when the link starts. Off by default: it
    would otherwise enter at prices the master never paid."""
    max_open_positions: int = 0
    """Cap on positions this link may hold on the destination. 0 disables."""
    max_slippage_points: int = 20

    # --- risk limits. 0 or empty turns a limit off. Days and hours are the
    # destination broker's server time, the clock MT5 charts show.
    max_trades_per_day: int = 0
    max_buy_lots: float = 0.0
    max_sell_lots: float = 0.0
    session_start: str = ""
    session_end: str = ""
    session_days: list[int] = field(default_factory=list)
    """Weekdays copying is allowed, 0 = Monday. Empty means every day."""
    max_daily_loss: float = 0.0
    """Money: realized plus floating P/L of this link's copies since server midnight."""
    max_consecutive_losses: int = 0
    max_loss_per_trade: float = 0.0
    """Money: a copy whose floating loss reaches this is closed on its own."""

    # --- exits
    exit_mode: str = "MASTER"
    trail_activation: float = 0.0
    """TRAILING: profit (money) at which trailing starts."""
    trail_drawdown_pct: float = 0.0
    """TRAILING: share of the peak profit allowed to give back before exiting."""

    def __post_init__(self) -> None:
        self.lot_mode = str(self.lot_mode).upper()
        if self.lot_mode not in LOT_MODES:
            raise ValueError(f"lot_mode must be one of {LOT_MODES}, got {self.lot_mode!r}")
        self.min_volume_action = str(self.min_volume_action).upper()
        if self.min_volume_action not in MIN_VOLUME_ACTIONS:
            raise ValueError(f"min_volume_action must be one of {MIN_VOLUME_ACTIONS}")
        if self.lot_value <= 0:
            raise ValueError("lot_value must be greater than zero")
        if self.equity_step <= 0:
            raise ValueError("equity_step must be greater than zero")
        if self.lot_mode == "RISK_PERCENT" and self.lot_value > 100:
            raise ValueError("the risk per trade cannot exceed 100% of equity")
        self.exit_mode = str(self.exit_mode or "MASTER").upper()
        if self.exit_mode not in EXIT_MODES:
            raise ValueError(f"exit_mode must be one of {EXIT_MODES}, got {self.exit_mode!r}")
        if not 0 <= self.trail_drawdown_pct < 100:
            raise ValueError("the trailing drawdown must be between 0 and 100%")
        if self.exit_mode == "TRAILING" and self.trail_drawdown_pct <= 0:
            raise ValueError("trailing needs a drawdown percentage above 0")
        start, end = parse_hhmm(self.session_start), parse_hhmm(self.session_end)
        if (start is None) != (end is None):
            raise ValueError("a trading session needs both a start and an end time")
        self.session_days = sorted({int(d) for d in (self.session_days or []) if 0 <= int(d) <= 6})
        self.symbol_map = {k.upper(): v for k, v in (self.symbol_map or {}).items()}
        self.allow_symbols = [symbol_base(s) for s in (self.allow_symbols or [])]
        self.deny_symbols = [symbol_base(s) for s in (self.deny_symbols or [])]

    # -- sessions ----------------------------------------------------------

    def session_closed_reason(self, server_now: float) -> str | None:
        """Why copying is outside its allowed hours right now, or None.

        ``server_now`` is the broker's wall clock expressed as epoch seconds,
        which is how MT5 reports server time.
        """
        start, end = parse_hhmm(self.session_start), parse_hhmm(self.session_end)
        if start is None and not self.session_days:
            return None
        wall = datetime.fromtimestamp(server_now, tz=timezone.utc)
        if self.session_days and wall.weekday() not in self.session_days:
            names = ", ".join(_WEEKDAYS[d] for d in self.session_days)
            return f"copying is only allowed on {names} (server time)"
        if start is None or start == end:
            return None
        minute = wall.hour * 60 + wall.minute
        inside = start <= minute < end if start < end else (minute >= start or minute < end)
        if inside:
            return None
        return f"outside the trading session {self.session_start}–{self.session_end} (server time)"

    # -- symbols -----------------------------------------------------------

    def symbol_allowed(self, master_symbol: str) -> bool:
        return self.filter_reason(master_symbol) is None

    def filter_reason(self, master_symbol: str) -> str | None:
        """Why this symbol is not copied, or None when it is allowed.

        Returned as a sentence rather than a boolean because a filter that
        silently swallows trades is indistinguishable from a broken copier.
        """
        base = symbol_base(master_symbol)
        if base in self.deny_symbols:
            return f"{base} is on this link's blocked list"
        if self.allow_symbols and base not in self.allow_symbols:
            allowed = ", ".join(sorted(self.allow_symbols))
            return (
                f"this link is set to copy only {allowed}, and {base} is not one of them"
            )
        return None

    def resolve_symbol(self, master_symbol: str, index: SymbolIndex) -> str:
        """Find the destination symbol for a master symbol.

        Order: explicit map, exact name, then base-name match preferring the
        configured suffix. Raises RuleError rather than guessing when a base
        name is ambiguous, so we never trade the wrong instrument.

        An explicit mapping is returned as written, without checking it against
        ``index``. That list comes from the terminal's local symbol cache, which
        is incomplete for a while after a terminal first starts and does not
        include instruments it has not pulled in yet. The terminal itself is the
        authority: the caller looks the symbol up there next, which selects it
        in Market Watch and fails with a clear error if it genuinely does not
        exist. Rejecting a mapping on the strength of a stale cache would refuse
        trades the destination can perfectly well take.
        """
        mapped = self.symbol_map.get(master_symbol.upper())
        if mapped:
            return index.exact(mapped) or mapped

        if not self.auto_match:
            raise RuleError(
                f"{master_symbol} has no mapping, and matching by base name is turned off "
                "for this link"
            )

        exact = index.exact(master_symbol)
        if exact:
            return exact

        base = symbol_base(master_symbol)
        candidates = index.by_base(base)
        if not candidates:
            raise RuleError(f"the destination has no symbol matching {master_symbol}")
        if len(candidates) == 1:
            return candidates[0]
        if self.symbol_suffix:
            preferred = [c for c in candidates if c.upper().endswith(self.symbol_suffix.upper())]
            if len(preferred) == 1:
                return preferred[0]
        raise RuleError(
            f"{master_symbol} matches several destination symbols ({', '.join(sorted(candidates))}); "
            "set a symbol suffix or an explicit mapping"
        )

    # -- sizing ------------------------------------------------------------

    def scale_volume(
        self,
        master_volume: float,
        *,
        master_balance: float,
        dest_balance: float,
        master_equity: float = 0.0,
        dest_equity: float = 0.0,
    ) -> float:
        """Unrounded destination volume before symbol constraints.

        RISK_PERCENT needs the stop distance and the symbol's tick value, so it
        is sized by :meth:`risk_volume` instead.
        """
        if self.lot_mode == "FIXED":
            return self.lot_value
        if self.lot_mode == "MULTIPLIER":
            return master_volume * self.lot_value
        if self.lot_mode == "EQUITY_STEP":
            # $1,000 -> 0.01 and $5,000 -> 0.05 with the defaults: whole steps
            # only, so the lot grows as the account does, never ahead of it.
            if dest_equity <= 0:
                raise RuleError("cannot size by equity: the destination equity is zero")
            return math.floor(round(dest_equity / self.equity_step, 9)) * self.lot_value
        if self.lot_mode == "RISK_PERCENT":
            raise RuleError("risk-based sizing needs the stop distance; use risk_volume()")
        if self.lot_mode == "BALANCE":
            if master_balance <= 0:
                raise RuleError("cannot scale by balance: the master balance is zero")
            return master_volume * (dest_balance / master_balance) * self.lot_value
        if master_equity <= 0:
            raise RuleError("cannot scale by equity: the master equity is zero")
        return master_volume * (dest_equity / master_equity) * self.lot_value

    def risk_volume(
        self,
        *,
        dest_equity: float,
        entry: float,
        stop: float,
        tick_size: float,
        tick_value: float,
    ) -> float:
        """Lots that lose ``lot_value`` percent of equity if the stop is hit.

        ``tick_value`` is what one tick is worth for one lot, in the account
        currency, so the loss per lot is the stop distance in ticks times that.
        """
        if not stop:
            raise RuleError("risk-based sizing needs a stop loss on the master trade")
        if tick_size <= 0 or tick_value <= 0:
            raise RuleError("the destination did not report a tick value for this symbol")
        loss_per_lot = abs(entry - stop) / tick_size * tick_value
        if loss_per_lot <= 0:
            raise RuleError("the master's stop loss is at its entry price")
        return dest_equity * (self.lot_value / 100.0) / loss_per_lot

    def round_volume(self, volume: float, spec: dict[str, Any]) -> float:
        """Snap a volume onto the destination symbol's lot grid.

        Rounds *down* to the step so a rounding error never increases exposure,
        then applies the symbol's own min/max and our max_lot cap.
        """
        step = float(spec.get("volumeStep") or 0.01)
        vol_min = float(spec.get("volumeMin") or 0.01)
        vol_max = float(spec.get("volumeMax") or 0.0)

        if self.max_lot > 0:
            volume = min(volume, self.max_lot)
        if vol_max > 0:
            volume = min(volume, vol_max)

        if step > 0:
            # Nudge before flooring: 0.3/0.1 is 2.9999... in binary.
            volume = math.floor(round(volume / step, 9)) * step
        # Lot grids are hundredths at the finest; 8 dp kills float dust.
        volume = round(volume, 8)

        if volume < vol_min:
            if self.min_volume_action == "MIN" and (self.max_lot <= 0 or vol_min <= self.max_lot):
                return round(vol_min, 8)
            return 0.0
        return volume

    def side_for(self, master_side: str) -> str:
        side = master_side.upper()
        if not self.reverse:
            return side
        return "SELL" if side == "BUY" else "BUY"

    def stops_for(self, master_sl: float, master_tp: float) -> tuple[float, float]:
        """Stop loss / take profit to copy.

        Reversed copying cannot reuse the master's levels — they sit on the
        wrong side of the price — so they are dropped and must be managed on
        the destination. A trailing link manages its own exit, so it takes
        none of the master's levels either.
        """
        if self.reverse or self.exit_mode == "TRAILING":
            return 0.0, 0.0
        return (
            float(master_sl or 0.0) if self.copy_sl else 0.0,
            float(master_tp or 0.0) if self.copy_tp else 0.0,
        )

    @property
    def follows_stops(self) -> bool:
        """Whether this link mirrors any of the master's SL/TP levels."""
        return not self.reverse and self.exit_mode == "MASTER" and (self.copy_sl or self.copy_tp)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbolMap": self.symbol_map,
            "symbolSuffix": self.symbol_suffix,
            "autoMatch": self.auto_match,
            "allowSymbols": self.allow_symbols,
            "denySymbols": self.deny_symbols,
            "lotMode": self.lot_mode,
            "lotValue": self.lot_value,
            "equityStep": self.equity_step,
            "maxLot": self.max_lot,
            "minVolumeAction": self.min_volume_action,
            "reverse": self.reverse,
            "copySl": self.copy_sl,
            "copyTp": self.copy_tp,
            "copyExisting": self.copy_existing,
            "maxOpenPositions": self.max_open_positions,
            "maxSlippagePoints": self.max_slippage_points,
            "maxTradesPerDay": self.max_trades_per_day,
            "maxBuyLots": self.max_buy_lots,
            "maxSellLots": self.max_sell_lots,
            "sessionStart": self.session_start,
            "sessionEnd": self.session_end,
            "sessionDays": self.session_days,
            "maxDailyLoss": self.max_daily_loss,
            "maxConsecutiveLosses": self.max_consecutive_losses,
            "maxLossPerTrade": self.max_loss_per_trade,
            "exitMode": self.exit_mode,
            "trailActivation": self.trail_activation,
            "trailDrawdownPct": self.trail_drawdown_pct,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "CopyRules":
        raw = raw or {}
        # Before SL and TP had separate switches, one copySlTp covered both.
        both = raw.get("copySlTp", True)
        return cls(
            symbol_map=raw.get("symbolMap") or {},
            symbol_suffix=raw.get("symbolSuffix") or "",
            auto_match=raw.get("autoMatch", True),
            allow_symbols=raw.get("allowSymbols") or [],
            deny_symbols=raw.get("denySymbols") or [],
            lot_mode=raw.get("lotMode") or "MULTIPLIER",
            lot_value=float(raw.get("lotValue") or 1.0),
            equity_step=float(raw.get("equityStep") or 1000.0),
            max_lot=float(raw.get("maxLot") or 0.0),
            min_volume_action=raw.get("minVolumeAction") or "SKIP",
            reverse=bool(raw.get("reverse")),
            copy_sl=bool(raw.get("copySl", both)),
            copy_tp=bool(raw.get("copyTp", both)),
            copy_existing=bool(raw.get("copyExisting")),
            max_open_positions=int(raw.get("maxOpenPositions") or 0),
            max_slippage_points=int(raw.get("maxSlippagePoints") or 20),
            max_trades_per_day=int(raw.get("maxTradesPerDay") or 0),
            max_buy_lots=float(raw.get("maxBuyLots") or 0.0),
            max_sell_lots=float(raw.get("maxSellLots") or 0.0),
            session_start=str(raw.get("sessionStart") or ""),
            session_end=str(raw.get("sessionEnd") or ""),
            session_days=list(raw.get("sessionDays") or []),
            max_daily_loss=float(raw.get("maxDailyLoss") or 0.0),
            max_consecutive_losses=int(raw.get("maxConsecutiveLosses") or 0),
            max_loss_per_trade=float(raw.get("maxLossPerTrade") or 0.0),
            exit_mode=str(raw.get("exitMode") or "MASTER"),
            trail_activation=float(raw.get("trailActivation") or 0.0),
            trail_drawdown_pct=float(raw.get("trailDrawdownPct") or 0.0),
        )


# Preview statuses, in the order an operator cares about them.
PREVIEW_BLOCKED = "BLOCKED"
PREVIEW_MANUAL = "MANUAL"
PREVIEW_AUTO = "AUTO"
PREVIEW_AMBIGUOUS = "AMBIGUOUS"
PREVIEW_UNMATCHED = "UNMATCHED"


def preview_translation(
    rules: "CopyRules", master_symbols: Iterable[str], index: SymbolIndex
) -> list[dict[str, Any]]:
    """Work out, per master symbol, what this link would do with it.

    Answers the question a skipped trade raises — "why did that not copy?" —
    before any money depends on the answer, and names the reason rather than
    just reporting a failure.
    """
    rows: list[dict[str, Any]] = []
    for name in master_symbols:
        blocked = rules.filter_reason(name)
        if blocked:
            rows.append({
                "source": name,
                "destination": None,
                "status": PREVIEW_BLOCKED,
                "detail": blocked,
            })
            continue
        manual = rules.symbol_map.get(name.upper())
        try:
            resolved = rules.resolve_symbol(name, index)
        except RuleError as exc:
            # An ambiguous base name is a different problem from no match at
            # all: one needs a suffix or a mapping, the other cannot be copied.
            status = (
                PREVIEW_AMBIGUOUS if "several destination symbols" in str(exc)
                else PREVIEW_UNMATCHED
            )
            rows.append({
                "source": name, "destination": None, "status": status, "detail": str(exc),
            })
            continue
        if manual:
            known = index.exact(manual)
            rows.append({
                "source": name,
                "destination": resolved,
                "status": PREVIEW_MANUAL,
                "detail": (
                    "mapped by hand"
                    if known
                    else "mapped by hand; the destination has not listed this symbol yet, "
                         "so it will be confirmed with the terminal when a trade arrives"
                ),
            })
        else:
            rows.append({
                "source": name,
                "destination": resolved,
                "status": PREVIEW_AUTO,
                "detail": f"matched on the base name {symbol_base(name)}",
            })
    return rows
