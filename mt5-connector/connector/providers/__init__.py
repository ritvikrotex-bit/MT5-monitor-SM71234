from __future__ import annotations

from connector.errors import AccountNotFound
from connector.schemas import (
    AccountResponse,
    ClientAccount,
    Credentials,
    OpenPosition,
    PositionsResponse,
    SearchResponse,
)


class Provider:
    mode: str

    def test(self, creds: Credentials) -> tuple[bool, str]:
        raise NotImplementedError

    def connect(self, creds: Credentials) -> tuple[str, str]:
        raise NotImplementedError

    def disconnect(self, creds: Credentials) -> tuple[str, str]:
        raise NotImplementedError

    def status(self, creds: Credentials) -> tuple[str, str]:
        raise NotImplementedError

    def search(self, creds: Credentials, query: str, by: str) -> SearchResponse:
        raise NotImplementedError

    def get_account(self, creds: Credentials, account: int) -> AccountResponse:
        raise NotImplementedError

    def get_positions(self, creds: Credentials, account: int) -> PositionsResponse:
        raise NotImplementedError


__all__ = [
    "AccountNotFound",
    "AccountResponse",
    "ClientAccount",
    "Credentials",
    "OpenPosition",
    "PositionsResponse",
    "Provider",
    "SearchResponse",
]
