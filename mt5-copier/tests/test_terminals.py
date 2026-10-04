"""Leftover terminals: found by path, closed only when older than the worker."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from copier import terminals, worker

EXE = Path(r"C:\mt5-terminals\WyncrestCapital-Trade-910102\terminal64.exe")


def test_only_terminals_from_this_folder_are_listed():
    output = "\n".join([
        r"11|1000000|C:\mt5-terminals\WyncrestCapital-Trade-910102\terminal64.exe",
        r"12|2000000|c:\MT5-TERMINALS\wyncrestcapital-trade-910102\TERMINAL64.EXE",
        r"13|3000000|C:\Program Files\MetaTrader 5\terminal64.exe",  # the user's own MT5
        r"14|4000000|",  # path hidden: leave it alone
        "not a process line",
    ])
    assert terminals.parse_terminal_list(output, EXE) == [(11, 1000.0), (12, 2000.0)]


def test_only_terminals_older_than_the_worker_are_closed(monkeypatch):
    monkeypatch.setattr(terminals, "running_from", lambda exe: [(21, 100.0), (22, 150.5), (23, 200.0)])
    killed: list[int] = []
    monkeypatch.setattr(terminals.os, "kill", lambda pid, sig: killed.append(pid))

    assert terminals.stop_stale(EXE, started_before=151.0) == [21]
    assert killed == [21]  # 22 is within a second of the worker: treated as its own


def test_a_terminal_that_cannot_be_closed_is_not_reported(monkeypatch):
    monkeypatch.setattr(terminals, "running_from", lambda exe: [(31, 1.0)])

    def deny(pid, sig):
        raise PermissionError("access denied")

    monkeypatch.setattr(terminals.os, "kill", deny)
    assert terminals.stop_stale(EXE, started_before=100.0) == []


@pytest.fixture
def fake_mt5(monkeypatch):
    state = {"initialize": [], "error": (-10005, "IPC timeout"), "calls": 0, "sleeps": []}

    def initialize(*args, **kwargs):
        state["calls"] += 1
        results = state["initialize"]
        return results.pop(0) if results else False

    monkeypatch.setattr(worker.terminals, "current_session", lambda: 1)  # a desktop session

    monkeypatch.setattr(worker.mt5, "shutdown", lambda: None)
    monkeypatch.setattr(worker.mt5, "initialize", initialize)
    monkeypatch.setattr(worker.mt5, "last_error", lambda: state["error"])
    monkeypatch.setattr(worker.mt5, "account_info", lambda: SimpleNamespace(login=910102, server="S"))
    monkeypatch.setattr(worker.time, "sleep", lambda s: state["sleeps"].append(s))
    return state


def test_an_ipc_timeout_closes_the_leftover_and_retries_at_once(fake_mt5, monkeypatch):
    fake_mt5["initialize"] = [False, True]
    calls: list[Path] = []
    monkeypatch.setattr(
        worker.terminals, "stop_stale", lambda exe, started_before: calls.append(exe) or [6068]
    )
    term = worker.Terminal(str(EXE), 910102, "pw", "S")

    term.connect()

    assert calls == [EXE]
    assert fake_mt5["sleeps"] == []


def test_a_terminal_that_never_answers_gets_an_actionable_error(fake_mt5, monkeypatch):
    calls: list[Path] = []
    monkeypatch.setattr(
        worker.terminals, "stop_stale", lambda exe, started_before: calls.append(exe) or []
    )
    term = worker.Terminal(str(EXE), 910102, "pw", "S")

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    assert len(calls) == 1  # cleared once, not on every attempt
    assert "IPC timeout" in str(exc.value) and "did not answer" in str(exc.value)


def test_a_service_session_fails_at_once_and_says_why(fake_mt5, monkeypatch):
    monkeypatch.setattr(worker.terminals, "current_session", lambda: 0)
    calls: list[Path] = []
    monkeypatch.setattr(
        worker.terminals, "stop_stale", lambda exe, started_before: calls.append(exe) or []
    )
    term = worker.Terminal(str(EXE), 910102, "pw", "S")

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    assert fake_mt5["calls"] == 1 and fake_mt5["sleeps"] == []  # no 8-minute retry loop
    assert calls == []
    assert "Windows service" in str(exc.value) and "install-copier-task.ps1" in str(exc.value)


def test_this_process_session_is_readable():
    assert isinstance(terminals.current_session(), int)


def test_a_starting_worker_is_not_reported_as_connected(tmp_path):
    from copier.pool import Account, Pool

    pool = Pool(tmp_path)
    pool.set_accounts([Account("a", "Slave", "S", 910102, "pw")])
    w = pool.get("a")
    w._proc = SimpleNamespace(poll=lambda: None)  # process up, terminal not answered yet

    assert pool.statuses()["a"]["running"] is True
    assert pool.statuses()["a"]["ready"] is False
    w.ready = True
    assert pool.statuses()["a"]["ready"] is True


def test_a_wrong_password_does_not_touch_any_terminal(fake_mt5, monkeypatch):
    fake_mt5["error"] = (-6, "Terminal: Authorization failed")
    calls: list[Path] = []
    monkeypatch.setattr(
        worker.terminals, "stop_stale", lambda exe, started_before: calls.append(exe) or []
    )
    term = worker.Terminal(str(EXE), 910102, "pw", "S")

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    assert calls == []
    assert "did not answer" not in str(exc.value)
