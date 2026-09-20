"""Read-only MT5 Manager provider for real client and position data.

Only these Manager API read methods are used: ``UserGet``, optional
``UserAccountGet``, optional ``UserGetByGroup`` and ``PositionGet``.  Session
creation remains in :mod:`connector.session`; no trade, dealer, order or
position-mutation method is exposed here.
"""
from __future__ import annotations

import time
from typing import Any, Callable, TypeVar

from connector.config import settings
from connector.errors import AccountNotFound, ConnectorError
from connector.normalize import client_from_user, position_from_mt
from connector.providers.base import Provider
from connector.schemas import AccountResponse, Credentials, PositionsResponse, SearchResponse
from connector import session as pool

T = TypeVar("T")

# Name/group lookup requires a roster scan in the verified Manager API.  Cache
# normalized, non-secret profile data in the connector so browser typing does
# not turn into repeated full-broker reads.  Account detail requests still read
# fresh data through UserGet/UserAccountGet.
_ROSTERS: dict[tuple[str, int, str], tuple[float, list[Any]]] = {}
_ROSTER_TTL_SECONDS = 300


class RealProvider(Provider):
    """Windows-only, serialized, read-only access to the MT5 Manager SDK."""
    mode = "real"

    def test(self, creds: Credentials) -> tuple[bool, str]:
        """Test broker connection credentials.

        Establishes a Manager session and returns True if successful.

        Raises:
            InvalidCredentials: If login/password rejected
            BrokerUnavailable: If broker is unreachable
            ConnectorError: If connection fails
        """
        with pool._LOCK:
            pool.acquire(creds)
            return True, f"Connected to {creds.server} as {creds.login}"

    def connect(self, creds: Credentials) -> tuple[str, str]:
        """Establish a persistent Manager session.

        Returns the connection status after acquiring the session.
        """
        with pool._LOCK:
            pool.acquire(creds)
        return pool.get_status(creds)

    def disconnect(self, creds: Credentials) -> tuple[str, str]:
        """Close and remove the Manager session.

        Safe to call even if not connected.
        """
        pool.disconnect(creds)
        return pool.get_status(creds)

    def status(self, creds: Credentials) -> tuple[str, str]:
        """Get current connection status for a broker.

        Returns (status_string, message) where status is:
        - CONNECTED: Session is active
        - DISCONNECTED: No active session
        - CONNECTING: Connection in progress
        - ERROR: Connection failed
        """
        return pool.get_status(creds)

    def _read(self, creds: Credentials, operation: Callable[[Any], T]) -> T:
        """Run one native read while holding the DLL lock, with one reconnect.

        The MT5 wheel is not thread-safe.  A reconnect is attempted only for a
        classified network failure, preventing browser retry storms from
        producing unbounded connection attempts.
        """
        with pool._LOCK:
            manager = pool.acquire(creds)
            try:
                return operation(manager)
            except Exception as exc:
                mt5 = pool.import_mt5()
                if not pool.is_network_error(mt5):
                    raise
                try:
                    manager = pool.reconnect(creds)
                    return operation(manager)
                except Exception as retry_exc:
                    raise ConnectorError(
                        f"MT5 read failed after reconnect: {retry_exc}", "BROKER_UNAVAILABLE"
                    ) from retry_exc

    @staticmethod
    def _user(manager: Any, account: int):
        user = manager.UserGet(int(account))
        if user is None:
            raise AccountNotFound(f"Account {account} not found.")
        return user

    @staticmethod
    def _account(manager: Any, account: int):
        """Use the optional account snapshot only when this SDK exposes it."""
        get_account = getattr(manager, "UserAccountGet", None)
        return get_account(int(account)) if callable(get_account) else None

    def search(self, creds: Credentials, query: str, by: str) -> SearchResponse:
        term = query.strip()
        if not term:
            return SearchResponse(clients=[], mode=self.mode)

        if by in {"login", "auto"} and term.isdecimal():
            account = int(term)
            try:
                return SearchResponse(
                    clients=[self._read(creds, lambda manager: client_from_user(self._user(manager, account), login=account))],
                    mode=self.mode,
                )
            except AccountNotFound:
                return SearchResponse(clients=[], mode=self.mode)

        # UserGetByGroup is build-dependent.  It is deliberately called with a
        # wildcard only on a stale roster; filtering happens locally thereafter.
        # This is the only verified way to search by a person's name while
        # keeping MT5 server work independent of browser request volume.
        key = (creds.server.strip(), int(creds.login), creds.password)
        cached = _ROSTERS.get(key)
        if cached and time.monotonic() - cached[0] < _ROSTER_TTL_SECONDS:
            roster = cached[1]
        else:
            roster = self._read(creds, self._load_roster)
            _ROSTERS[key] = (time.monotonic(), roster)

        needle = term.casefold()
        clients = []
        for candidate in roster:
            haystack = candidate.group if by == "group" else candidate.name
            if needle in (haystack or "").casefold():
                clients.append(candidate)
                if len(clients) >= settings.mt5_search_limit:
                    break
        clients.sort(key=lambda candidate: (candidate.name.casefold() != needle, candidate.login))
        return SearchResponse(clients=clients, mode=self.mode)

    @staticmethod
    def _load_roster(manager: Any):
        """Fetch and normalize one bounded-by-time cached broker roster."""
        def group_search():
            method = getattr(manager, "UserGetByGroup", None)
            if not callable(method):
                raise ConnectorError(
                    "This MT5 Manager SDK does not support group/name search.",
                    "SEARCH_NOT_SUPPORTED",
                )
            users = method("*")
            if users is None or users is False:
                raise ConnectorError("MT5 UserGetByGroup failed.", "BROKER_UNAVAILABLE")
            return [client_from_user(user) for user in users]

        return group_search()

    def get_account(self, creds: Credentials, account: int) -> AccountResponse:
        def load(manager: Any):
            return client_from_user(
                self._user(manager, account),
                self._account(manager, account),
                login=account,
            )

        return AccountResponse(client=self._read(creds, load), mode=self.mode)

    def get_positions(self, creds: Credentials, account: int) -> PositionsResponse:
        def load(manager: Any):
            method = getattr(manager, "PositionGet", None)
            if not callable(method):
                raise ConnectorError(
                    "This MT5 Manager SDK does not expose PositionGet.", "POSITIONS_NOT_SUPPORTED"
                )
            raw = method(int(account))
            return [position_from_mt(position) for position in (raw or [])]

        positions = self._read(creds, load)
        return PositionsResponse(
            clientLogin=int(account),
            positions=positions,
            slTpAvailable=any(position.sl is not None or position.tp is not None for position in positions),
            mode=self.mode,
        )
