"""Durable per-link state: which destination position mirrors which master one.

The engine reconciles state rather than replaying events, so a restart must not
re-open trades it already copied or forget the ones it owns. This module is
that memory. It is written atomically after every change, because the process
can be killed at any moment by a service restart.

The mapping is also recoverable without this file: every copied position
carries the link's magic number and a ``c<master ticket>`` comment. The file is
the fast path; the magic number is the backstop.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("copier.state")

# An open that fails for a non-transient reason (unmapped symbol, lot below the
# minimum) is retried on this schedule instead of on every cycle.
FAILURE_BACKOFF = (5, 15, 60, 300, 900)


@dataclass
class LinkState:
    """Everything the engine must remember about one master -> destination link."""

    link_id: str
    seeded: bool = False
    """True once the link has decided what to do about pre-existing positions."""
    mapping: dict[int, int] = field(default_factory=dict)
    """master ticket -> destination ticket."""
    ignored: list[int] = field(default_factory=list)
    """Master tickets deliberately not copied (open before the link started)."""
    manual_closes: set[int] = field(default_factory=set)
    """Master tickets whose slave copy was manually closed while the master was
    still open.  The engine will not re-open these until the master itself closes
    the trade (at which point the entry is cleared)."""
    failures: dict[int, dict[str, Any]] = field(default_factory=dict)
    """master ticket -> {attempts, nextTry, reason}."""
    baseline_equity: float | None = None
    """Destination equity when the link was armed, for the drawdown guard."""
    halted_reason: str | None = None
    """Set when a guard tripped; the link stays stopped until a human clears it."""
    copied_count: int = 0
    last_action_at: float | None = None

    opened: dict[int, dict[str, Any]] = field(default_factory=dict)
    """master ticket -> what was copied: master and copy volume at open, so a
    partial close on the master shrinks the copy by the same share."""
    day: str | None = None
    """The destination's server date (YYYY-MM-DD) the daily counters belong to."""
    trades_today: int = 0
    notified: dict[str, str] = field(default_factory=dict)
    """risk trigger -> server date it was last reported, so each limit alerts
    once a day instead of on every blocked trade."""
    risk_block: str | None = None
    """Set by the consecutive-loss limit; copying stays paused until re-armed."""
    streak_since: float | None = None
    """UTC time losses are counted from; re-arming starts a fresh streak."""
    peaks: dict[int, float] = field(default_factory=dict)
    """master ticket -> highest profit its copy has reached, for trailing."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "linkId": self.link_id,
            "seeded": self.seeded,
            "mapping": {str(k): v for k, v in self.mapping.items()},
            "ignored": sorted(self.ignored),
            "manualCloses": sorted(self.manual_closes),
            "failures": {str(k): v for k, v in self.failures.items()},
            "baselineEquity": self.baseline_equity,
            "haltedReason": self.halted_reason,
            "copiedCount": self.copied_count,
            "lastActionAt": self.last_action_at,
            "opened": {str(k): v for k, v in self.opened.items()},
            "day": self.day,
            "tradesToday": self.trades_today,
            "notified": dict(self.notified),
            "riskBlock": self.risk_block,
            "streakSince": self.streak_since,
            "peaks": {str(k): v for k, v in self.peaks.items()},
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "LinkState":
        return cls(
            link_id=raw["linkId"],
            seeded=bool(raw.get("seeded")),
            mapping={int(k): int(v) for k, v in (raw.get("mapping") or {}).items()},
            ignored=[int(t) for t in (raw.get("ignored") or [])],
            manual_closes={int(t) for t in (raw.get("manualCloses") or [])},
            failures={int(k): v for k, v in (raw.get("failures") or {}).items()},
            baseline_equity=raw.get("baselineEquity"),
            halted_reason=raw.get("haltedReason"),
            copied_count=int(raw.get("copiedCount") or 0),
            last_action_at=raw.get("lastActionAt"),
            opened={int(k): dict(v) for k, v in (raw.get("opened") or {}).items()},
            day=raw.get("day"),
            trades_today=int(raw.get("tradesToday") or 0),
            notified=dict(raw.get("notified") or {}),
            risk_block=raw.get("riskBlock"),
            streak_since=raw.get("streakSince"),
            peaks={int(k): float(v) for k, v in (raw.get("peaks") or {}).items()},
        )

    # -- failure backoff ---------------------------------------------------

    def should_retry(self, master_ticket: int, now: float | None = None) -> bool:
        entry = self.failures.get(master_ticket)
        if not entry:
            return True
        return (now or time.time()) >= float(entry.get("nextTry") or 0)

    def record_failure(self, master_ticket: int, reason: str, now: float | None = None) -> None:
        now = now or time.time()
        entry = self.failures.get(master_ticket) or {"attempts": 0}
        attempts = int(entry.get("attempts") or 0)
        delay = FAILURE_BACKOFF[min(attempts, len(FAILURE_BACKOFF) - 1)]
        self.failures[master_ticket] = {
            "attempts": attempts + 1,
            "nextTry": now + delay,
            "reason": reason,
            "at": now,
        }

    def clear_failure(self, master_ticket: int) -> None:
        self.failures.pop(master_ticket, None)


class StateStore:
    """All link states in one JSON file, written atomically."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self._links: dict[str, LinkState] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.is_file():
            return
        try:
            # A file written by another tool may carry a BOM; tolerate it.
            raw = json.loads(self.path.read_text(encoding="utf-8-sig") or "{}")
        except (json.JSONDecodeError, OSError) as exc:
            backup = self.path.with_suffix(f".corrupt-{int(time.time())}.json")
            log.error("copier state at %s is unreadable (%s); moving it to %s", self.path, exc, backup)
            try:
                self.path.replace(backup)
            except OSError:
                pass
            return
        for entry in raw.get("links") or []:
            try:
                state = LinkState.from_dict(entry)
            except (KeyError, TypeError, ValueError) as exc:
                log.error("skipping malformed link state %s: %s", entry, exc)
                continue
            self._links[state.link_id] = state
        log.info("loaded state for %d link(s) from %s", len(self._links), self.path)

    def get(self, link_id: str) -> LinkState:
        with self._lock:
            state = self._links.get(link_id)
            if state is None:
                state = LinkState(link_id=link_id)
                self._links[link_id] = state
            return state

    def forget(self, link_id: str) -> None:
        with self._lock:
            if self._links.pop(link_id, None) is not None:
                self.save()

    def all(self) -> dict[str, LinkState]:
        with self._lock:
            return dict(self._links)

    def save(self) -> None:
        with self._lock:
            # Links run on their own threads and change their own state without
            # this lock, so a dict can change size while it is being read. That
            # is rare and harmless to retry; it must not crash a cycle.
            for attempt in range(5):
                try:
                    payload = {"links": [s.to_dict() for s in self._links.values()]}
                    break
                except RuntimeError:
                    if attempt == 4:
                        log.warning("copier state kept changing while saving; will retry next cycle")
                        return
                    time.sleep(0.01)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            try:
                tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                os.replace(tmp, self.path)
            except OSError as exc:
                log.error("could not write copier state to %s: %s", self.path, exc)
