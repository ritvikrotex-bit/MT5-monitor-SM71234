"""Reading a master through the Manager API (mt5-connector)."""
from __future__ import annotations

from pathlib import Path

import pytest

from copier.engine import Engine, Link
from copier.rules import CopyRules
from copier.sources import (
    ManagerMaster,
    MasterReader,
    SourceUnavailable,
    TerminalMaster,
    parse_master,
)
from copier.state import StateStore
from tests.test_engine import FakeAccount, FakePool

MASTER = ManagerMaster(
    label="TD Capital 100003",
    server="31.14.254.192:443",
    manager_login=12345,
    manager_password="secret",
    account=100003,
)


class FakeConnector:
    """Stands in for mt5-connector's read-only endpoints."""

    def __init__(self, client: dict | None = None, positions: list[dict] | None = None) -> None:
        self.client = client if client is not None else {
            "login": 100003, "name": "Rotex Test Ritvik", "group": "100003",
            "balance": 6494.88, "equity": 6694.88, "margin": 120.0,
            "leverage": 50000, "currency": "USD",
        }
        self.positions = positions if positions is not None else []
        self.calls: list[tuple[str, dict]] = []
        self.fail: Exception | None = None

    def post(self, path: str, body: dict) -> dict:
        self.calls.append((path, body))
        if self.fail:
            raise self.fail
        if path == "/v1/clients/get":
            return {"client": self.client}
        if path == "/v1/clients/positions":
            return {"clientLogin": body["account"], "positions": self.positions,
                    "slTpAvailable": True}
        raise AssertionError(path)


def position(**overrides) -> dict:
    return {
        "positionId": "556677", "symbol": "XAUUSD.c", "direction": "BUY", "volume": 0.10,
        "openPrice": 1950.25, "currentPrice": 1951.0, "profit": 7.5,
        "sl": None, "tp": None, "openedAt": "10:15:03", **overrides,
    }


# -- parsing ---------------------------------------------------------------

def test_parses_a_manager_master():
    spec = parse_master({
        "kind": "MANAGER", "label": "m", "server": "1.2.3.4:443",
        "managerLogin": 7, "managerPassword": "p", "account": 100003,
    })
    assert isinstance(spec, ManagerMaster)
    assert (spec.server, spec.manager_login, spec.account) == ("1.2.3.4:443", 7, 100003)


def test_manager_is_the_default_kind():
    spec = parse_master({
        "server": "1.2.3.4:443", "managerLogin": 7, "managerPassword": "p", "account": 1,
    })
    assert isinstance(spec, ManagerMaster)


def test_incomplete_manager_master_is_refused():
    with pytest.raises(ValueError, match="managerPassword"):
        parse_master({"kind": "MANAGER", "server": "s", "managerLogin": 7, "account": 1})


def test_unknown_kind_is_refused():
    with pytest.raises(ValueError, match="unknown master kind"):
        parse_master({"kind": "TELEPATHY"})


def test_parses_a_terminal_master():
    spec = parse_master({"kind": "TERMINAL", "label": "m", "accountId": "abc"})
    assert isinstance(spec, TerminalMaster) and spec.account_id == "abc"


# -- reading ---------------------------------------------------------------

def test_a_manager_snapshot_looks_like_a_worker_snapshot():
    connector = FakeConnector(positions=[position()])
    snapshot = MasterReader(connector).snapshot(MASTER)

    assert snapshot["account"]["balance"] == 6494.88
    assert snapshot["account"]["equity"] == 6694.88
    assert snapshot["account"]["login"] == 100003
    # A master is never traded on, whatever the Manager API says about it.
    assert snapshot["account"]["tradeAllowed"] is False

    [pos] = snapshot["positions"]
    assert pos["ticket"] == 556677
    assert pos["symbol"] == "XAUUSD.c"
    assert pos["side"] == "BUY"
    assert pos["volume"] == 0.10
    # null stops arrive as None and must become 0, not crash the sizing maths
    assert (pos["sl"], pos["tp"]) == (0.0, 0.0)


def test_stops_are_carried_through():
    connector = FakeConnector(positions=[position(sl=1940.0, tp=1975.5)])
    [pos] = MasterReader(connector).snapshot(MASTER)["positions"]
    assert (pos["sl"], pos["tp"]) == (1940.0, 1975.5)


def test_a_sell_keeps_its_direction():
    connector = FakeConnector(positions=[position(direction="SELL")])
    [pos] = MasterReader(connector).snapshot(MASTER)["positions"]
    assert pos["side"] == "SELL"


def test_positions_without_a_usable_ticket_are_dropped():
    # "0" is what the connector falls back to when the SDK gave no id; copying
    # one would make the mapping meaningless.
    connector = FakeConnector(positions=[position(positionId="0"), position(positionId="x"), position()])
    assert len(MasterReader(connector).snapshot(MASTER)["positions"]) == 1


def test_the_account_is_cached_but_positions_are_not():
    connector = FakeConnector(positions=[position()])
    master = MasterReader(connector)
    for _ in range(3):
        master.snapshot(MASTER)
    paths = [p for p, _ in connector.calls]
    assert paths.count("/v1/clients/get") == 1, "re-read the balance every cycle"
    assert paths.count("/v1/clients/positions") == 3, "cached the positions"


def test_the_manager_password_goes_to_the_connector_not_the_account_login():
    connector = FakeConnector(positions=[position()])
    MasterReader(connector).snapshot(MASTER)
    _, body = connector.calls[0]
    assert body["login"] == 12345 and body["password"] == "secret"
    assert body["account"] == 100003


def test_a_connector_outage_surfaces_as_source_unavailable():
    connector = FakeConnector()
    connector.fail = SourceUnavailable("connector down")
    with pytest.raises(SourceUnavailable):
        MasterReader(connector).snapshot(MASTER)


def test_a_manager_master_without_a_connector_is_an_error():
    with pytest.raises(SourceUnavailable, match="no connector"):
        MasterReader(None).snapshot(MASTER)


# -- end to end through the engine -----------------------------------------

def test_the_engine_copies_from_a_manager_master(tmp_path: Path):
    connector = FakeConnector()
    dest = FakeAccount(910102, ["XAUUSD.s"], balance=22016.01)
    pool = FakePool({"d": dest})
    engine = Engine(pool, StateStore(tmp_path / "s.json"), MasterReader(connector, pool),
                    poll_interval=0.01)
    link = Link(id="L", label="live", master=MASTER, dest_id="d", enabled=True, dry_run=False,
                rules=CopyRules(lot_mode="MULTIPLIER", lot_value=1.0))
    engine.set_links([link])

    engine.run_link(link)  # seeds against an empty master
    assert dest.positions == {}

    connector.positions = [position()]
    engine.run_link(link)
    [copied] = dest.positions.values()
    assert copied["symbol"] == "XAUUSD.s"
    assert copied["volume"] == 0.10
    assert copied["comment"] == "c556677"

    # and it closes when the master's position disappears from the Manager feed
    connector.positions = []
    engine.run_link(link)
    assert dest.positions == {}


def test_a_connector_outage_does_not_close_the_copies(tmp_path: Path):
    """An unreadable master must never look like a master with no positions."""
    connector = FakeConnector()
    dest = FakeAccount(910102, ["XAUUSD.s"], balance=22016.01)
    pool = FakePool({"d": dest})
    engine = Engine(pool, StateStore(tmp_path / "s.json"), MasterReader(connector, pool),
                    poll_interval=0.01)
    link = Link(id="L", label="live", master=MASTER, dest_id="d", enabled=True, dry_run=False)
    engine.set_links([link])
    engine.run_link(link)  # seeds against an empty master
    connector.positions = [position()]
    engine.run_link(link)
    assert len(dest.positions) == 1

    connector.fail = SourceUnavailable("connector down")
    engine._safe_run(link)
    assert len(dest.positions) == 1, "an outage closed the copied position"
    assert "connector down" in str(engine.status()["links"][0]["cycle"]["error"])
