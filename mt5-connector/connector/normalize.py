"""Normalize verified Manager API objects into DTOs. Never return raw SDK objects."""
from __future__ import annotations

from datetime import datetime, timezone

from connector.schemas import ClientAccount, OpenPosition


def _num(value, default=None):
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value, default=None):
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def volume_lots(obj) -> float:
    """Return the documented lot value without guessing a broker scale.

    The verified MT5Manager API exposes both fixed-point forms: ``VolumeExt``
    is lots × 1e8 and ``Volume`` is lots × 1e4.
    """
    ext = getattr(obj, "VolumeExt", 0) or 0
    if ext:
        return float(ext) / 1e8
    raw = getattr(obj, "Volume", 0) or 0
    try:
        vol = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return vol / 1e4


def _price(obj, *names: str) -> float | None:
    for name in names:
        value = getattr(obj, name, None)
        n = _num(value)
        if n is not None and n != 0:
            return n
    for name in names:
        n = _num(getattr(obj, name, None))
        if n is not None:
            return n
    return None


def _direction(obj) -> str:
    action = getattr(obj, "Action", None)
    if action is None:
        action = getattr(obj, "Type", 0)
    # The verified Manager API values are 0 = BUY and 1 = SELL.  Unknown
    # values must not silently become a valid trading direction.
    if int(action or 0) == 0:
        return "BUY"
    if int(action) == 1:
        return "SELL"
    raise ValueError(f"Unsupported MT5 position direction: {action!r}")


def _position_id(obj) -> str:
    for name in ("Position", "PositionID", "Ticket"):
        value = getattr(obj, name, None)
        if value:
            return str(value)
    return "0"


def _opened_at(obj) -> str | None:
    ts = getattr(obj, "TimeCreate", None)
    if ts is None:
        ts = getattr(obj, "Time", None)
    if isinstance(ts, (int, float)) and ts > 0:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S")
    return None


def client_from_user(user, account=None, login: int | None = None) -> ClientAccount:
    resolved_login = _int(getattr(user, "Login", None), login or 0) or 0
    balance = _num(getattr(account, "Balance", None) if account is not None else None)
    if balance is None:
        balance = _num(getattr(user, "Balance", None))
    equity = _num(getattr(account, "Equity", None) if account is not None else None)
    if equity is None:
        equity = _num(getattr(user, "Equity", None), balance)
    margin = _num(getattr(account, "Margin", None) if account is not None else None)
    floating = _num(getattr(account, "Profit", None) if account is not None else None)
    if floating is None and equity is not None and balance is not None:
        floating = round(equity - balance, 2)

    return ClientAccount(
        login=resolved_login,
        name=str(getattr(user, "Name", "") or "") or f"Login {resolved_login}",
        group=str(getattr(user, "Group", "") or "") or None,
        balance=balance,
        equity=equity,
        margin=margin,
        floatingProfit=floating,
        leverage=_int(getattr(user, "Leverage", None)),
        currency=str(getattr(user, "Currency", "") or "") or None,
    )


def position_from_mt(obj) -> OpenPosition:
    # PriceCurrent is optional.  Do not substitute another SDK price because
    # the UI must distinguish unavailable market-side price from a real value.
    sl = _price(obj, "PriceSL", "SL")
    tp = _price(obj, "PriceTP", "TP")
    current = _price(obj, "PriceCurrent")
    open_price = _price(obj, "PriceOpen")
    if open_price is None:
        raise ValueError("MT5 position did not include PriceOpen")
    return OpenPosition(
        positionId=_position_id(obj),
        symbol=str(getattr(obj, "Symbol", "") or ""),
        direction=_direction(obj),
        volume=round(volume_lots(obj), 8),
        openPrice=open_price,
        currentPrice=current,
        profit=_num(getattr(obj, "Profit", 0), 0.0) or 0.0,
        sl=sl if sl not in (0, 0.0) else None,
        tp=tp if tp not in (0, 0.0) else None,
        openedAt=_opened_at(obj),
    )
