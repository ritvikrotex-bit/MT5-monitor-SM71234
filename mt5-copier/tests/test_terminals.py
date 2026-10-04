"""Terminals the copier cannot use, why a start failed, and HTTP callers never held for a start."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from copier import terminals, worker
from copier.pool import Account, Pool, TerminalStarting, WorkerDown

EXE = Path(r"C:\mt5-terminals\WyncrestCapital-Trade-910102\terminal64.exe")


# -- finding and closing terminals -----------------------------------------

def test_only_terminals_from_this_folder_are_listed():
    output = "\n".join([
        r"11|1000000|2|C:\mt5-terminals\WyncrestCapital-Trade-910102\terminal64.exe",
        r"12|2000000|0|c:\MT5-TERMINALS\wyncrestcapital-trade-910102\TERMINAL64.EXE",
        r"13|3000000|2|C:\Program Files\MetaTrader 5\terminal64.exe",  # the user's own MT5
        r"14|4000000|2|",  # path hidden: leave it alone
        "not a process line",
    ])
    assert terminals.parse_terminal_list(output, EXE) == [(11, 1000.0, 2), (12, 2000.0, 0)]


def _kill_recorder(monkeypatch) -> list[int]:
    killed: list[int] = []
    monkeypatch.setattr(terminals.os, "kill", lambda pid, sig: killed.append(pid))
    return killed


def test_terminals_older_than_the_worker_are_closed(monkeypatch):
    monkeypatch.setattr(
        terminals, "running_from", lambda exe: [(21, 100.0, 2), (22, 150.5, 2), (23, 200.0, 2)]
    )
    killed = _kill_recorder(monkeypatch)

    assert terminals.stop_stale(EXE, started_before=151.0, session=2) == [21]
    assert killed == [21]  # 22 is within a second of the worker: treated as its own


def test_a_terminal_in_another_session_is_closed_whatever_its_age(monkeypatch):
    # e.g. stranded in session 0 by the old Windows service
    monkeypatch.setattr(terminals, "running_from", lambda exe: [(31, 500.0, 0), (32, 500.0, 2)])
    killed = _kill_recorder(monkeypatch)

    assert terminals.stop_stale(EXE, started_before=0.0, session=2) == [31]
    assert killed == [31]


def test_a_terminal_that_cannot_be_closed_is_not_reported(monkeypatch):
    monkeypatch.setattr(terminals, "running_from", lambda exe: [(41, 1.0, 2)])

    def deny(pid, sig):
        raise PermissionError("access denied")

    monkeypatch.setattr(terminals.os, "kill", deny)
    assert terminals.stop_stale(EXE, started_before=100.0, session=2) == []


def test_this_process_session_is_readable():
    assert isinstance(terminals.current_session(), int)


# -- what the terminal says when it will not answer -------------------------

def _write_journal(folder: Path, day: str, lines: list[str]) -> Path:
    exe = folder / "terminal64.exe"
    (folder / "logs").mkdir(parents=True)
    (folder / "logs" / f"{day}.log").write_text("\r\n".join(lines) + "\r\n", encoding="utf-16")
    return exe


def test_the_journal_since_the_start_is_quoted_without_noise(tmp_path):
    since = time.mktime(time.strptime("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S"))
    exe = _write_journal(tmp_path, "20261004", [
        "AA\t0\t11:59:59.000\tTerminal\tan earlier run",
        "BB\t0\t12:00:01.000\tTerminal\tMetaTrader 5 x64 build 4410 started",
        "CC\t3\t12:00:01.100\tMCP\tbind error on 127.0.0.1:22346",
        "DD\t0\t12:00:02.000\tLiveUpdate\tnew version build 6182 is available",
        "EE\t2\t12:00:09.000\tNetwork\t'910102': authorization on WyncrestCapital-Trade failed",
    ])

    assert terminals.journal_tail(exe, since=since) == [
        "Terminal: MetaTrader 5 x64 build 4410 started",
        "LiveUpdate: new version build 6182 is available",
        "Network: '910102': authorization on WyncrestCapital-Trade failed",
    ]
    assert terminals.journal_tail(exe, since=since, limit=1) == [
        "Network: '910102': authorization on WyncrestCapital-Trade failed"
    ]


def test_a_terminal_that_closes_at_once_is_named(tmp_path, monkeypatch):
    monkeypatch.setattr(terminals, "running_from", lambda exe: [])

    text = terminals.describe_failure(tmp_path / "terminal64.exe", since=time.time())

    assert "it closes as soon as it starts" in text
    assert "nothing in its journal" in text


def test_a_dialog_the_terminal_shows_is_named(tmp_path, monkeypatch):
    monkeypatch.setattr(terminals, "running_from", lambda exe: [(51, 1.0, 2)])
    monkeypatch.setattr(terminals, "window_titles", lambda pids: ["Open an Account"])

    text = terminals.describe_failure(tmp_path / "terminal64.exe", since=time.time())

    assert "pid 51" in text and '"Open an Account"' in text


# -- connecting -------------------------------------------------------------

@pytest.fixture
def fake_mt5(monkeypatch):
    state = {"initialize": [], "error": (-10005, "IPC timeout"), "calls": 0, "sleeps": [],
             "stale": [], "described": 0}

    def initialize(*args, **kwargs):
        state["calls"] += 1
        results = state["initialize"]
        return results.pop(0) if results else False

    def stop_stale(exe, *, started_before, session=None):
        state["stale"].append((started_before, session))
        return state.get("stopped", {}).get(started_before == 0.0, [])

    def describe(exe, *, since):
        state["described"] += 1
        return "terminal running (pid 7); its journal: \"Network: no connection\""

    monkeypatch.setattr(worker.terminals, "current_session", lambda: 2)  # a desktop session
    monkeypatch.setattr(worker.terminals, "stop_stale", stop_stale)
    monkeypatch.setattr(worker.terminals, "describe_failure", describe)
    monkeypatch.setattr(worker.mt5, "shutdown", lambda: None)
    monkeypatch.setattr(worker.mt5, "initialize", initialize)
    monkeypatch.setattr(worker.mt5, "last_error", lambda: state["error"])
    monkeypatch.setattr(worker.mt5, "account_info", lambda: SimpleNamespace(login=910102, server="S"))
    monkeypatch.setattr(worker.time, "sleep", lambda s: state["sleeps"].append(s))
    return state


def _terminal() -> worker.Terminal:
    return worker.Terminal(str(EXE), 910102, "pw", "S")


def test_terminals_in_other_sessions_are_closed_before_the_first_attempt(fake_mt5):
    fake_mt5["initialize"] = [True]
    term = _terminal()

    term.connect()

    assert fake_mt5["stale"] == [(0.0, 2)]  # foreign sessions only, before initialize


def test_an_ipc_timeout_closes_the_leftover_and_retries_at_once(fake_mt5):
    fake_mt5["initialize"] = [False, True]
    fake_mt5["stopped"] = {False: [6068]}  # the after-failure sweep finds an orphan
    term = _terminal()

    term.connect()

    assert fake_mt5["stale"] == [(0.0, 2), (term._started, 2)]
    assert fake_mt5["sleeps"] == []


def test_a_terminal_that_never_answers_says_what_it_shows(fake_mt5):
    term = _terminal()

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    message = str(exc.value)
    assert "IPC timeout" in message and "did not answer" in message
    assert "Network: no connection" in message and "copier-doctor.ps1" in message
    assert len(fake_mt5["stale"]) == 2  # once before, once after the first failure
    assert fake_mt5["described"] == 1


def test_a_service_session_fails_at_once_and_says_why(fake_mt5, monkeypatch):
    monkeypatch.setattr(worker.terminals, "current_session", lambda: 0)
    term = _terminal()

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    assert fake_mt5["calls"] == 1 and fake_mt5["sleeps"] == []  # no 8-minute retry loop
    assert fake_mt5["stale"] == []  # a service must not close a desktop session's terminals
    assert "Windows service" in str(exc.value) and "install-copier-task.ps1" in str(exc.value)


def test_a_wrong_password_closes_nothing_after_failing(fake_mt5):
    fake_mt5["error"] = (-6, "Terminal: Authorization failed")
    term = _terminal()

    with pytest.raises(worker.WorkerError) as exc:
        term.connect()

    assert fake_mt5["stale"] == [(0.0, 2)]  # only the check before the first attempt
    assert "did not answer" not in str(exc.value)
    assert fake_mt5["described"] == 0


# -- the pool: honest status, and HTTP callers not held for a start --------

def _pool(tmp_path):
    pool = Pool(tmp_path)
    pool.set_accounts([Account("a", "Slave", "S", 910102, "pw")])
    return pool, pool.get("a")


def test_a_starting_worker_is_not_reported_as_connected(tmp_path):
    pool, w = _pool(tmp_path)
    w._proc = SimpleNamespace(poll=lambda: None)  # process up, terminal not answered yet

    status = pool.statuses()["a"]
    assert status["running"] is True and status["ready"] is False

    w.ready = True
    assert pool.statuses()["a"]["ready"] is True


def test_an_idle_terminal_is_started_in_the_background(tmp_path, monkeypatch):
    pool, w = _pool(tmp_path)
    release = threading.Event()
    starts: list[int] = []

    def slow_start(self):
        starts.append(1)
        self._starting = True
        release.wait(5)
        self._starting = False

    monkeypatch.setattr(type(w), "start", slow_start)

    with pytest.raises(TerminalStarting):
        pool.connected("a")
    assert w.starting is True
    assert pool.statuses()["a"]["starting"] is True
    with pytest.raises(TerminalStarting):
        pool.connected("a")  # a second click while it starts does not start another

    release.set()
    for _ in range(50):
        if not w.starting:
            break
        time.sleep(0.02)
    assert starts == [1] and w.starting is False


def test_a_start_that_just_failed_reports_why_instead_of_retrying(tmp_path):
    pool, w = _pool(tmp_path)
    w.last_error = "initialize failed: (-10005, 'IPC timeout'): the MT5 terminal did not answer"
    w._next_try = time.time() + 30

    with pytest.raises(WorkerDown) as exc:
        pool.connected("a")

    assert not isinstance(exc.value, TerminalStarting)
    assert "did not answer" in str(exc.value)
    assert w.starting is False


def test_a_connected_worker_is_returned_as_is(tmp_path):
    pool, w = _pool(tmp_path)
    w._proc = SimpleNamespace(poll=lambda: None)
    w.ready = True

    assert pool.connected("a") is w
