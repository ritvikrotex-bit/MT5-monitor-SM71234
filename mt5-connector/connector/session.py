"""MT5 Manager session pooling with thread-safe caching and keepalive.

This module manages persistent MT5 Manager API connections, serializes access
to the non-thread-safe DLL, and provides automatic reconnection on network errors.

Session cache key: (server, login, password) -> {manager, last, M}
All manager API calls must be serialized with _LOCK (MT5 DLL is not thread-safe).

Verified against:
  - AI-MT5-Logs-Analyser reference implementation
  - MT5_INTEGRATION_GUIDE.md
  - MT5Manager 5.0.5735+ wheel (Python 3.10-3.13)
"""
from __future__ import annotations

import threading
import time
from typing import Any

from connector.config import settings
from connector.errors import BrokerUnavailable, ConnectorError, InvalidCredentials
from connector.schemas import Credentials

# Status strings
DISCONNECTED = "DISCONNECTED"
CONNECTING = "CONNECTING"
CONNECTED = "CONNECTED"
RECONNECTING = "RECONNECTING"
ERROR = "ERROR"

# Global state
_LOCK = threading.RLock()  # Serialize all MT5 Manager API calls (DLL not thread-safe)
_CACHE: dict[tuple, dict[str, Any]] = {}  # (server, login, password) -> {manager, last, M}
_CONNECTING: set[tuple] = set()  # Keys currently being connected
_STATUS: dict[tuple, dict[str, str]] = {}  # Last known status for each broker
_KEEPALIVE_STARTED = False  # Track if background thread started


def import_mt5():
    """Import MT5Manager or raise ConnectorError if not available."""
    try:
        import MT5Manager  # type: ignore
        return MT5Manager
    except Exception as exc:
        raise ConnectorError(
            "MT5Manager not available. Install with: pip install MT5Manager (Windows x64, Python 3.10-3.13)",
            "CONNECTOR_UNAVAILABLE",
        ) from exc


def last_error(M) -> str:
    """Format MT5Manager.LastError() tuple as string."""
    try:
        return f"{M.LastError()}"
    except Exception:
        return "unknown error"


def is_network_error(M) -> bool:
    """True if last error indicates connection dropped (recoverable)."""
    try:
        text = f"{M.LastError()}".upper()
        return any(x in text for x in ("NETWORK", "CONNECT", "NOTCONNECTED", "TIMEOUT", "DISCONNECT"))
    except Exception:
        return False


def classify_connect_error(message: str) -> ConnectorError:
    """Classify connection error into appropriate exception type."""
    text = message.upper()
    if any(x in text for x in ("AUTH", "PASSWORD", "LOGIN", "INVALID", "DENIED")):
        return InvalidCredentials(message)
    if any(x in text for x in ("NETWORK", "TIMEOUT", "UNREACH", "REFUSED", "NOTCONNECTED")):
        return BrokerUnavailable(message)
    return ConnectorError(message, "BROKER_UNAVAILABLE")


def pump_mode(M) -> int:
    """Get minimal pump mode for this MT5Manager build.

    PUMP_MODE_USERS is always available. PUMP_MODE_FULL is all-bits mask and
    causes server rejection on verified builds — avoid it.
    """
    modes = M.ManagerAPI.EnPumpModes
    users = int(modes.PUMP_MODE_USERS)
    # Try to add PUMP_MODE_POSITIONS if available, else PUMP_MODE_TRADES, else just USERS
    positions = int(getattr(modes, "PUMP_MODE_POSITIONS", 0) or 0)
    trades = int(getattr(modes, "PUMP_MODE_TRADES", 0) or 0)
    extra = positions if positions else trades
    return users | extra if extra else users


def cache_key(creds: Credentials) -> tuple:
    """Generate cache key from broker credentials."""
    server = creds.server.strip()
    return (server, int(creds.login), creds.password)


def _set_status(key: tuple, status: str, message: str) -> None:
    """Record status for a broker key."""
    _STATUS[key] = {"status": status, "message": message}


def get_status(creds: Credentials) -> tuple[str, str]:
    """Get current connection status for a broker."""
    key = cache_key(creds)
    with _LOCK:
        if key in _CONNECTING:
            return CONNECTING, "Connecting to the MT5 server."
        if key in _CACHE:
            return CONNECTED, "Manager session is connected."
        info = _STATUS.get(key)
        if info:
            return info["status"], info["message"]
        return DISCONNECTED, "No Manager session for this broker."


def _connect(M, creds: Credentials):
    """Establish a new Manager connection (must be called with _LOCK held)."""
    manager = M.ManagerAPI()
    ok = manager.Connect(
        creds.server,
        int(creds.login),
        creds.password,
        pump_mode(M),
        settings.mt5_timeout_ms,
    )
    if not ok:
        raise classify_connect_error(f"Connect failed: {last_error(M)}")
    return manager


def drop(key: tuple) -> None:
    """Remove and close a cached session (must be called with _LOCK held)."""
    ent = _CACHE.pop(key, None)
    if ent:
        try:
            ent["manager"].Disconnect()
        except Exception:
            pass


def acquire(creds: Credentials):
    """Get or create a cached Manager connection.

    Thread-safe. Serializes duplicate connections so only one socket per broker.

    Raises:
        InvalidCredentials: Bad credentials
        BrokerUnavailable: Broker unreachable
        ConnectorError: Connection failed
    """
    global _KEEPALIVE_STARTED
    M = import_mt5()
    key = cache_key(creds)
    ttl = settings.mt5_session_ttl

    with _LOCK:
        # Check if cached and valid
        ent = _CACHE.get(key)
        if ent and (ttl <= 0 or (time.time() - ent["last"]) < ttl):
            ent["last"] = time.time()
            return ent["manager"]
        if ent:
            drop(key)

        # Mark as connecting to prevent duplicate connect attempts
        _CONNECTING.add(key)
        _set_status(key, CONNECTING, "Connecting to the MT5 server.")
        try:
            manager = _connect(M, creds)
            _CACHE[key] = {"manager": manager, "last": time.time(), "M": M}
            _set_status(key, CONNECTED, "Connected.")

            # Start keepalive thread once on first connect
            if not _KEEPALIVE_STARTED:
                interval = settings.mt5_keepalive_sec
                if interval and interval > 0:
                    threading.Thread(
                        target=_keepalive_loop,
                        args=(interval,),
                        name="mt5-keepalive",
                        daemon=True,
                    ).start()
                _KEEPALIVE_STARTED = True

            return manager
        except Exception as exc:
            _set_status(key, ERROR, str(exc))
            raise
        finally:
            _CONNECTING.discard(key)


def reconnect(creds: Credentials):
    """Reconnect a broker session (drops cached connection and re-acquires)."""
    key = cache_key(creds)
    with _LOCK:
        _set_status(key, RECONNECTING, "Reconnecting Manager session.")
        drop(key)
    return acquire(creds)


def disconnect(creds: Credentials) -> None:
    """Close and remove a cached session."""
    key = cache_key(creds)
    with _LOCK:
        drop(key)
        _set_status(key, DISCONNECTED, "Disconnected.")


def is_alive(M, manager, login: int) -> bool:
    """Liveness check: returns False only if network error detected."""
    try:
        manager.UserGet(int(login))
    except Exception:
        pass
    return not is_network_error(M)


def _keepalive_loop(interval: int) -> None:
    """Background thread: periodically probe and reconnect sessions."""
    while True:
        time.sleep(interval)
        with _LOCK:
            for key in list(_CACHE.keys()):
                ent = _CACHE.get(key)
                if not ent:
                    continue
                M, manager = ent["M"], ent["manager"]
                server, login, password = key
                try:
                    if is_alive(M, manager, login):
                        continue
                    # Session dropped — reconnect
                    _set_status(key, RECONNECTING, "Session dropped; reconnecting.")
                    try:
                        manager.Disconnect()
                    except Exception:
                        pass
                    creds = Credentials(server=server, login=login, password=password)
                    ent["manager"] = _connect(M, creds)
                    ent["last"] = time.time()
                    _set_status(key, CONNECTED, "Reconnected.")
                except Exception as exc:
                    # Reconnect failed — drop so next real request retries with proper error
                    _CACHE.pop(key, None)
                    _set_status(key, ERROR, str(exc))
