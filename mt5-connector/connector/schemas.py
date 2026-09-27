from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Credentials(BaseModel):
    server: str = Field(description="MT5 manager host, optionally host:port")
    login: int
    password: str


class TestResponse(BaseModel):
    ok: bool
    message: str
    mode: str
    status: str
    build: int | None = None


class SessionRequest(Credentials):
    pass


class StatusResponse(BaseModel):
    status: str
    message: str
    mode: str


class SearchRequest(Credentials):
    query: str
    by: Literal["login", "name", "group", "auto"] = "auto"


class AccountRequest(Credentials):
    account: int


class ClientAccount(BaseModel):
    login: int
    name: str
    group: str | None = None
    balance: float | None = None
    equity: float | None = None
    margin: float | None = None
    floatingProfit: float | None = None
    leverage: int | None = None
    currency: str | None = None


class OpenPosition(BaseModel):
    positionId: str
    symbol: str
    direction: Literal["BUY", "SELL"]
    volume: float
    openPrice: float
    currentPrice: float | None = None
    profit: float
    sl: float | None = None
    tp: float | None = None
    openedAt: str | None = None


class SearchResponse(BaseModel):
    clients: list[ClientAccount]
    mode: str


class AccountResponse(BaseModel):
    client: ClientAccount
    mode: str


class PositionsResponse(BaseModel):
    clientLogin: int
    positions: list[OpenPosition]
    slTpAvailable: bool
    mode: str


class SymbolsResponse(BaseModel):
    """Every symbol configured on the server this Manager session is on."""

    symbols: list[str]
    total: int
    mode: str
