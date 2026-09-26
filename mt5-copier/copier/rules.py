"""Per-link copy rules: which symbol on the destination, and what lot size.

Brokers rarely agree on symbol names ("XAUUSD.c" on one server, "XAUUSD.s" on
another) or on account size, so every link carries a :class:`CopyRules` that
translates a master position into a destination order.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

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


LOT_MODES = ("FIXED", "MULTIPLIER", "BALANCE", "EQUITY")
MIN_VOLUME_ACTIONS = ("SKIP", "MIN")


@dataclass
class CopyRules:
    """How one master's trades become one destination's trades."""

    # --- symbols
    symbol_map: dict[str, str] = field(default_factory=dict)
    """Explicit master symbol -> destination symbol. Wins over everything else."""
    symbol_suffix: str = ""
    """Preferred destination suffix when a base name matches several symbols."""
    allow_symbols: list[str] = field(default_factory=list)
    """Base names to copy. Empty means all."""
    deny_symbols: list[str] = field(default_factory=list)
    """Base names never to copy."""

    # --- sizing
    lot_mode: str = "MULTIPLIER"
    lot_value: float = 1.0
    """FIXED: the lot itself. Otherwise a factor applied to the scaled volume."""
    max_lot: float = 0.0
    """Hard cap per order. 0 disables."""
    min_volume_action: str = "SKIP"
    """What to do when the computed lot is under the symbol minimum."""

    # --- behaviour
    reverse: bool = False
    copy_sl_tp: bool = True
    copy_existing: bool = False
    """Copy positions already open when the link starts. Off by default: it
    would otherwise enter at prices the master never paid."""
    max_open_positions: int = 0
    """Cap on positions this link may hold on the destination. 0 disables."""
    max_slippage_points: int = 20

    def __post_init__(self) -> None:
        self.lot_mode = str(self.lot_mode).upper()
        if self.lot_mode not in LOT_MODES:
            raise ValueError(f"lot_mode must be one of {LOT_MODES}, got {self.lot_mode!r}")
        self.min_volume_action = str(self.min_volume_action).upper()
        if self.min_volume_action not in MIN_VOLUME_ACTIONS:
            raise ValueError(f"min_volume_action must be one of {MIN_VOLUME_ACTIONS}")
        if self.lot_value <= 0:
            raise ValueError("lot_value must be greater than zero")
        self.symbol_map = {k.upper(): v for k, v in (self.symbol_map or {}).items()}
        self.allow_symbols = [symbol_base(s) for s in (self.allow_symbols or [])]
        self.deny_symbols = [symbol_base(s) for s in (self.deny_symbols or [])]

    # -- symbols -----------------------------------------------------------

    def symbol_allowed(self, master_symbol: str) -> bool:
        base = symbol_base(master_symbol)
        if base in self.deny_symbols:
            return False
        return not self.allow_symbols or base in self.allow_symbols

    def resolve_symbol(self, master_symbol: str, index: SymbolIndex) -> str:
        """Find the destination symbol for a master symbol.

        Order: explicit map, exact name, then base-name match preferring the
        configured suffix. Raises RuleError rather than guessing when a base
        name is ambiguous, so we never trade the wrong instrument.
        """
        mapped = self.symbol_map.get(master_symbol.upper())
        if mapped:
            found = index.exact(mapped)
            if not found:
                raise RuleError(
                    f"{master_symbol} is mapped to {mapped}, which the destination does not offer"
                )
            return found

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
        """Unrounded destination volume before symbol constraints."""
        if self.lot_mode == "FIXED":
            return self.lot_value
        if self.lot_mode == "MULTIPLIER":
            return master_volume * self.lot_value
        if self.lot_mode == "BALANCE":
            if master_balance <= 0:
                raise RuleError("cannot scale by balance: the master balance is zero")
            return master_volume * (dest_balance / master_balance) * self.lot_value
        if master_equity <= 0:
            raise RuleError("cannot scale by equity: the master equity is zero")
        return master_volume * (dest_equity / master_equity) * self.lot_value

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
        the destination.
        """
        if not self.copy_sl_tp or self.reverse:
            return 0.0, 0.0
        return float(master_sl or 0.0), float(master_tp or 0.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbolMap": self.symbol_map,
            "symbolSuffix": self.symbol_suffix,
            "allowSymbols": self.allow_symbols,
            "denySymbols": self.deny_symbols,
            "lotMode": self.lot_mode,
            "lotValue": self.lot_value,
            "maxLot": self.max_lot,
            "minVolumeAction": self.min_volume_action,
            "reverse": self.reverse,
            "copySlTp": self.copy_sl_tp,
            "copyExisting": self.copy_existing,
            "maxOpenPositions": self.max_open_positions,
            "maxSlippagePoints": self.max_slippage_points,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "CopyRules":
        raw = raw or {}
        return cls(
            symbol_map=raw.get("symbolMap") or {},
            symbol_suffix=raw.get("symbolSuffix") or "",
            allow_symbols=raw.get("allowSymbols") or [],
            deny_symbols=raw.get("denySymbols") or [],
            lot_mode=raw.get("lotMode") or "MULTIPLIER",
            lot_value=float(raw.get("lotValue") or 1.0),
            max_lot=float(raw.get("maxLot") or 0.0),
            min_volume_action=raw.get("minVolumeAction") or "SKIP",
            reverse=bool(raw.get("reverse")),
            copy_sl_tp=raw.get("copySlTp", True),
            copy_existing=bool(raw.get("copyExisting")),
            max_open_positions=int(raw.get("maxOpenPositions") or 0),
            max_slippage_points=int(raw.get("maxSlippagePoints") or 20),
        )
