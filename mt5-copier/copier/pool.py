"""Supervises one :mod:`copier.worker` subprocess per account.

Each worker owns a terminal and an account. This module starts them, sends
commands, and restarts one that dies without taking the engine down with it.

Commands to a single worker are serialized: the MT5 API behind it is
single-threaded anyway, and serializing keeps request/response matching simple.
"""
from __future__ import annotations

import itertools
import json
import logging
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from copier import terminals

log = logging.getLogger("copier.pool")

# A worker that dies is retried with a growing delay so a bad password or an
# unreachable broker does not spin the CPU.
RESTART_BACKOFF = (2, 5, 15, 30, 60)

# Upper bound on a cold terminal's first start, matching the worker's own
# connect retries.
STARTUP_TIMEOUT = 600.0


class WorkerDown(Exception):
    """The worker is not running, or did not answer in time."""


class CommandFailed(Exception):
    """The worker answered, but the command itself failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Account:
    """A trading account the copier can attach to."""

    id: str
    label: str
    server: str
    login: int
    password: str

    def redacted(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "server": self.server, "login": self.login}


class Worker:
    """A single account's worker subprocess."""

    def __init__(self, account: Account, *, terminals_root: Path, python: str | None = None) -> None:
        self.account = account
        self.terminals_root = terminals_root
        self.python = python or sys.executable
        self._proc: subprocess.Popen | None = None
        self._replies: queue.Queue[dict[str, Any]] = queue.Queue()
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._failures = 0
        self._next_try = 0.0
        self.last_error: str | None = None

    # -- lifecycle ---------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        """Launch the worker and wait for its ready banner."""
        if self.alive:
            return
        if time.time() < self._next_try:
            raise WorkerDown(f"{self.account.label}: backing off ({self.last_error})")

        exe = terminals.provision(
            self.account.server, self.account.login, root=self.terminals_root
        )
        log.info("starting worker for %s (%s)", self.account.label, self.account.login)
        self._proc = subprocess.Popen(
            [
                self.python, "-u", "-m", "copier.worker",
                "--login", str(self.account.login),
                "--server", self.account.server,
                "--terminal", str(exe),
                "--label", self.account.label,
            ],
            cwd=str(Path(__file__).resolve().parent.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # worker logs flow into ours
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        # The password goes over the pipe, never on the command line.
        assert self._proc.stdin is not None
        self._proc.stdin.write(self.account.password + "\n")
        self._proc.stdin.flush()

        self._replies = queue.Queue()
        self._reader = threading.Thread(
            target=self._read_loop, args=(self._proc,), daemon=True,
            name=f"worker-{self.account.login}",
        )
        self._reader.start()

        try:
            # Generous: a terminal that has never run has to unpack and sync
            # before it answers, and the worker retries through that.
            banner = self._await(0, timeout=STARTUP_TIMEOUT)
        except Exception:
            self._record_failure("did not become ready")
            self.stop()
            raise
        if not banner.get("ok"):
            error = banner.get("error") or {}
            self._record_failure(error.get("message", "worker failed to start"))
            self.stop()
            raise WorkerDown(f"{self.account.label}: {error.get('message')}")
        self._failures = 0
        self.last_error = None
        log.info("worker ready for %s", self.account.label)

    def _record_failure(self, message: str) -> None:
        self.last_error = message
        delay = RESTART_BACKOFF[min(self._failures, len(RESTART_BACKOFF) - 1)]
        self._failures += 1
        self._next_try = time.time() + delay
        log.warning("worker %s down: %s (retry in %ss)", self.account.label, message, delay)

    def _read_loop(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._replies.put(json.loads(line))
            except json.JSONDecodeError:
                log.debug("worker %s emitted non-JSON: %s", self.account.label, line[:200])

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # -- protocol ----------------------------------------------------------

    def _await(self, req_id: int, *, timeout: float) -> dict[str, Any]:
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise WorkerDown(f"{self.account.label}: timed out waiting for reply {req_id}")
            try:
                reply = self._replies.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                if not self.alive:
                    raise WorkerDown(f"{self.account.label}: worker exited")
                continue
            if reply.get("id") == req_id:
                return reply
            log.debug("discarding stale reply %s", reply.get("id"))

    def call(self, cmd: str, args: dict[str, Any] | None = None, *, timeout: float = 60) -> dict[str, Any]:
        """Send one command and return its result.

        Raises WorkerDown if the process is not usable, CommandFailed if the
        command was rejected by the terminal or the broker.
        """
        with self._lock:
            if not self.alive:
                self.start()
            assert self._proc is not None and self._proc.stdin is not None
            req_id = next(self._ids)
            try:
                self._proc.stdin.write(json.dumps({"id": req_id, "cmd": cmd, "args": args or {}}) + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                self._record_failure(f"pipe broke: {exc}")
                self.stop()
                raise WorkerDown(f"{self.account.label}: {exc}") from exc

            try:
                reply = self._await(req_id, timeout=timeout)
            except WorkerDown:
                self._record_failure("no reply")
                self.stop()
                raise

        if reply.get("ok"):
            return reply.get("result") or {}
        error = reply.get("error") or {}
        raise CommandFailed(error.get("code", "UNKNOWN"), error.get("message", ""))


class Pool:
    """All account workers, keyed by account id."""

    def __init__(self, terminals_root: Path) -> None:
        self.terminals_root = terminals_root
        self._workers: dict[str, Worker] = {}
        self._lock = threading.Lock()

    def set_accounts(self, accounts: list[Account]) -> None:
        """Reconcile running workers with the configured account list."""
        wanted = {a.id: a for a in accounts}
        with self._lock:
            for account_id in list(self._workers):
                current = self._workers[account_id].account
                replacement = wanted.get(account_id)
                if replacement is None or replacement != current:
                    log.info("stopping worker %s (removed or changed)", current.label)
                    self._workers.pop(account_id).stop()
            for account_id, account in wanted.items():
                self._workers.setdefault(
                    account_id, Worker(account, terminals_root=self.terminals_root)
                )

    def get(self, account_id: str) -> Worker:
        with self._lock:
            worker = self._workers.get(account_id)
        if worker is None:
            raise WorkerDown(f"no worker for account {account_id}")
        return worker

    def statuses(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            workers = dict(self._workers)
        return {
            account_id: {
                **worker.account.redacted(),
                "running": worker.alive,
                "lastError": worker.last_error,
            }
            for account_id, worker in workers.items()
        }

    def stop_all(self) -> None:
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            worker.stop()
