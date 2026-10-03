"""A link that cannot read its master or slave must say so, once, and say when it is back.

Until this existed, a dead connector stopped all copying with nothing but a
line in the cycle status: trades went uncopied and no alert was sent.
"""
from __future__ import annotations

from copier import engine as engine_module
from copier.pool import WorkerDown
from test_refresh_and_testrun import kinds, last, setup  # noqa: F401  (fixture)


def test_an_unreadable_master_is_reported_once_and_so_is_its_return(setup, monkeypatch):
    master, dest, engine, state, make_link = setup
    monkeypatch.setattr(engine_module, "OUTAGE_ALERT_AFTER", 0.0)
    link = make_link()
    engine.run_link(link)
    master.add("XAUUSD.c", "BUY", 0.10)
    engine.run_link(link)  # one copy open

    for _ in range(3):
        master.fail_on["snapshot"] = WorkerDown("the MT5 connector is unreachable")
        engine._safe_run(link)

    assert kinds(engine).count("outage") == 1
    outage = last(engine, "outage")
    assert outage["account"] == "master"
    assert "connector is unreachable" in outage["reason"]
    assert outage["openCopies"] == 1

    engine._safe_run(link)
    assert kinds(engine).count("recovered") == 1
    assert last(engine, "recovered")["account"] == "master"


def test_an_unreachable_slave_is_reported_as_the_slave(setup, monkeypatch):
    master, dest, engine, state, make_link = setup
    monkeypatch.setattr(engine_module, "OUTAGE_ALERT_AFTER", 0.0)
    link = make_link()
    dest.fail_on["snapshot"] = WorkerDown("terminal is down")

    engine._safe_run(link)

    assert last(engine, "outage")["account"] == "slave"


def test_a_brief_blip_is_not_reported(setup):
    master, dest, engine, state, make_link = setup
    link = make_link()
    master.fail_on["snapshot"] = WorkerDown("one slow read")

    engine._safe_run(link)
    engine._safe_run(link)

    assert "outage" not in kinds(engine)
    assert "recovered" not in kinds(engine)


def test_trades_resume_after_the_master_comes_back(setup, monkeypatch):
    master, dest, engine, state, make_link = setup
    monkeypatch.setattr(engine_module, "OUTAGE_ALERT_AFTER", 0.0)
    link = make_link()
    engine.run_link(link)

    master.fail_on["snapshot"] = WorkerDown("connector down")
    engine._safe_run(link)
    master.add("XAUUSD.c", "BUY", 0.10)  # opened while we could not see
    engine._safe_run(link)

    assert len(dest.positions) == 1
    assert kinds(engine).index("recovered") < kinds(engine).index("opened")
