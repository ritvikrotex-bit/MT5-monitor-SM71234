from __future__ import annotations

from connector.schemas import (
    AccountResponse,
    Credentials,
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
