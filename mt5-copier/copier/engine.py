"""The copy engine.

Every cycle the engine *reconciles* rather than replays: it reads the master's
open positions, reads the positions it owns on the destination, and issues the
orders that make the second look like the first. Nothing depends on catching an
event at the right moment, so a restart, a dropped connection or a missed cycle
cannot duplicate or lose a trade.

Positions the engine owns are stamped with the link's magic number and a
``c<master ticket>`` comment. Anything on the destination without that magic is
somebody else's trade and is never touched.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from copier.pool import CommandFailed, Pool, WorkerDown
from copier.rules import CopyRules, RuleError, SymbolIndex
from copier.sources import MasterReader, MasterSpec, SourceUnavailable, parse_master
from copier.state import LinkState, StateStore

log = logging.getLogger("copier.engine")

# Copied positions carry this in their comment so ownership survives losing the
# state file. Master tickets are long, so the \d{4,} guard avoids matching a
# broker's own decoration.
COMMENT_RE = re.compile(r"(?:^|[^0-9A-Za-z])c(\d{4,})")

# Magic numbers are namespaced under this prefix so copied positions are
# recognisable at a glance in the terminal.
MAGIC_PREFIX = 0x5C000000

SYMBOL_CACHE_TTL = 300.0

# Logging the destination in again is how its terminal learns about a symbol
# the broker enabled after it connected. It briefly takes the account offline,
# so it is rationed: once per account every few minutes, and once per symbol
# per half hour, so a symbol that really is missing does not keep the account
# cycling through logins for as long as the master holds the trade.
ACCOUNT_REFRESH_GAP = 300.0
SYMBOL_REFRESH_COOLDOWN = 1800.0
REFRESH_TIMEOUT = 150.0

# A link that cannot read its master or slave copies and closes nothing, and
# until now said so only in its cycle status. A blip (one slow read, a service
# restarting) is normal, so an outage is reported once it has lasted this long,
# and its end is reported too.
OUTAGE_ALERT_AFTER = 20.0

# Stops the slave refused (too close to price, usually) are retried this often,
# and reported only once per set of levels.
STOP_RETRY_AFTER = 60.0

# A close that fails (market closed, no quote) is retried after these pauses
# rather than on every one-second cycle.
CLOSE_RETRY_BACKOFF = (1, 2, 5, 10, 30)

# The deal history behind the daily-loss and losing-streak limits is re-read
# this often, and at once whenever a copy opens or closes.
LEDGER_REFRESH = 15.0
# How far back a losing streak is looked for when it has never been reset.
LEDGER_STREAK_WINDOW = 7 * 86_400.0

# A master trade must be seen within this long of executing for its time to be
# used to learn the master broker's clock offset.
MASTER_CLOCK_TOLERANCE = 120.0

# SYMBOL_TRADE_MODE_* values that forbid opening a trade in a given direction.
_CLOSED_TRADE_MODES = {0: "disabled", 3: "set to close-only"}
_ONE_WAY_TRADE_MODES = {1: "BUY", 2: "SELL"}


class SymbolLookupFailed(Exception):
    """A master symbol could not be translated to a tradable destination one."""

    def __init__(
        self, message: str, *, dest_symbol: str | None = None, sizing: bool = False
    ) -> None:
        super().__init__(message)
        self.dest_symbol = dest_symbol
        self.sizing = sizing
        """The symbol is fine but the lot could not be worked out (no stop for
        risk sizing, a zero balance): refreshing the account will not help."""
        self.refresh: dict[str, Any] | None = None
        """What logging the destination in again found, when that was tried."""


def magic_for(link_id: str) -> int:
    """Stable per-link magic number derived from the link id."""
    return MAGIC_PREFIX | (zlib.crc32(link_id.encode()) & 0x00FFFFFF)


def parse_master_ticket(comment: str) -> int | None:
    match = COMMENT_RE.search(comment or "")
    return int(match.group(1)) if match else None


def _summarise_deals(
    deals: list[dict[str, Any]],
    *,
    day_start: float,
    streak_from: float,
    still_open: set[int],
) -> dict[str, Any]:
    """Realized P/L since ``day_start`` and the losing streak since ``streak_from``.

    Times are on the broker's clock. A position's result is the sum of all its
    deals (partial closes, swap, commission on the way in and out); it counts
    toward the streak once it is fully closed, in the order it was closed.
    """
    realized = 0.0
    positions: dict[int, dict[str, float]] = {}
    for deal in deals:
        amount = float(deal["profit"]) + float(deal["swap"]) + float(deal["commission"])
        if deal["time"] >= day_start:
            realized += amount
        if deal["time"] < streak_from:
            continue
        entry = positions.setdefault(int(deal["positionId"]), {"total": 0.0, "closedAt": 0.0})
        entry["total"] += amount
        if deal.get("closing"):
            entry["closedAt"] = max(entry["closedAt"], float(deal.get("timeMsc") or deal["time"] * 1000))
    closed = sorted(
        (entry["closedAt"], entry["total"])
        for position_id, entry in positions.items()
        if entry["closedAt"] and position_id not in still_open
    )
    streak = 0
    for _, total in reversed(closed):
        if total >= 0:
            break
        streak += 1
    return {"realized": realized, "streak": streak, "closedToday": len(closed)}


def _ledger_view(ledger: dict[str, Any] | None) -> dict[str, Any] | None:
    if not ledger:
        return None
    floating = float(ledger.get("floating") or 0.0)
    return {
        "realized": round(ledger["realized"], 2),
        "floating": round(floating, 2),
        "total": round(ledger["realized"] + floating, 2),
        "lossStreak": ledger["streak"],
    }


def _stamp_execution_times(snapshot: dict[str, Any]) -> None:
    """Give master positions an ``executedAt`` in UTC epoch seconds, if possible.

    MT5 reports times on the broker's own clock (``openedAtMsc``), so they are
    only comparable with ours once that clock's offset is known.
    """
    offset = snapshot.get("serverOffset")
    if not isinstance(offset, (int, float)):
        return
    for position in snapshot.get("positions") or []:
        msc = position.get("openedAtMsc")
        if isinstance(msc, (int, float)) and msc > 0:
            position["executedAt"] = msc / 1000.0 - float(offset)


def _duration(seconds: float) -> str:
    """'45 s', '4 min 12 s', '2 h 5 min'."""
    seconds = int(max(seconds, 0))
    if seconds < 60:
        return f"{seconds} s"
    minutes, secs = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes} min {secs} s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min"


def _describe_refresh(note: dict[str, Any]) -> str:
    """One line for the activity log about a destination re-login."""
    if not note.get("ok"):
        return f"could not log the destination in again: {note.get('error')}"
    symbol = note.get("symbol")
    counts = f"{note.get('symbolsBefore')} → {note.get('symbolsAfter')} symbols"
    if not symbol:
        return f"logged the destination in again to refresh its symbols ({counts})"
    if note.get("available"):
        return f"logged the destination in again; {symbol} is now available ({counts})"
    return (
        f"logged the destination in again; {symbol} is still unavailable "
        f"({note.get('reason') or 'unknown reason'})"
    )


@dataclass
class Link:
    """One master account copied onto one destination account."""

    id: str
    label: str
    master: MasterSpec
    dest_id: str
    rules: CopyRules = field(default_factory=CopyRules)
    enabled: bool = False
    dry_run: bool = True
    max_drawdown_pct: float = 0.0
    """Stop the link and flatten it if destination equity falls this far below
    the baseline captured when it was armed. 0 disables."""
    owner_id: str | None = None
    """Web-app user this link belongs to, used to route alerts."""

    @property
    def magic(self) -> int:
        return magic_for(self.id)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Link":
        return cls(
            id=str(raw["id"]),
            label=str(raw.get("label") or raw["id"]),
            master=parse_master(raw["master"]),
            dest_id=str(raw["destId"]),
            rules=CopyRules.from_dict(raw.get("rules")),
            enabled=bool(raw.get("enabled")),
            dry_run=bool(raw.get("dryRun", True)),
            max_drawdown_pct=float(raw.get("maxDrawdownPct") or 0.0),
            owner_id=raw.get("ownerId"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "master": {"kind": type(self.master).__name__, "label": self.master.label},
            "destId": self.dest_id,
            "rules": self.rules.to_dict(),
            "enabled": self.enabled,
            "dryRun": self.dry_run,
            "maxDrawdownPct": self.max_drawdown_pct,
            "ownerId": self.owner_id,
            "magic": self.magic,
        }


class Engine:
    """Runs every enabled link on a fixed cycle."""

    def __init__(
        self,
        pool: Pool,
        state: StateStore,
        masters: MasterReader | None = None,
        *,
        poll_interval: float = 1.0,
        snapshot_timeout: float = 45.0,
        order_timeout: float = 60.0,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        max_parallel_links: int = 4,
        journal: Any = None,
    ) -> None:
        self.pool = pool
        self.state = state
        self.masters = masters or MasterReader(None, pool)
        self.poll_interval = poll_interval
        self.snapshot_timeout = snapshot_timeout
        self.order_timeout = order_timeout
        self.on_event = on_event
        self.max_parallel_links = max_parallel_links

        self.links: dict[str, Link] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._events: list[dict[str, Any]] = []
        self._sequence = 0
        self._cycle: dict[str, dict[str, Any]] = {}
        self._symbols: dict[str, tuple[float, SymbolIndex]] = {}
        self._specs: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._account_refreshed: dict[str, float] = {}
        self._symbol_refreshed: dict[tuple[str, str], float] = {}
        # link id -> {"side", "since", "reason", "alerted"} while a read is failing.
        self._outages: dict[str, dict[str, Any]] = {}
        # (link id, slave ticket) -> (levels the slave refused, when to retry).
        self._stop_failures: dict[tuple[str, int], tuple[tuple[float, float], float]] = {}
        # (link id, master ticket) already announced in dry run, so a dry run
        # reports each trade once instead of on every cycle.
        self._dry_seen: set[tuple[str, int]] = set()
        # destination account id -> last known broker server offset from UTC (s).
        self._server_offsets: dict[str, float] = {}
        # (link id, master ticket) -> when the copier first saw it, for latency.
        self._first_seen: dict[tuple[str, int], float] = {}
        # (link id, slave ticket) -> {"attempts", "nextTry", "reason"} for closes that failed.
        self._close_failures: dict[tuple[str, int], dict[str, Any]] = {}
        # link id -> today's realized P/L, floating P/L and losing streak.
        self._ledgers: dict[str, dict[str, Any]] = {}
        # master key -> its broker clock's offset from UTC, learned from trades.
        self._master_offsets: dict[str, float] = {}
        self.journal = journal

    # -- configuration -----------------------------------------------------

    def set_links(self, links: list[Link]) -> None:
        with self._lock:
            incoming = {link.id: link for link in links}
            for link_id in list(self.links):
                if link_id not in incoming:
                    log.info("link %s removed from config", link_id)
                    self._cycle.pop(link_id, None)
            self.links = incoming

    def arm(self, link_id: str) -> None:
        """Clear a halt and start the link again from now.

        Seeding is reset deliberately. A link that halted on the drawdown guard
        has just been flattened, and the master is usually still holding those
        losing trades; without re-seeding, arming would pile straight back into
        every one of them at whatever price they trade at now. Arming means
        "resume from here", so whatever is open on the master at that moment is
        left alone unless the link is set to copy existing positions.

        Positions the link still owns stay mapped, so they are still managed.
        """
        state = self.state.get(link_id)
        state.halted_reason = None
        state.baseline_equity = None
        state.seeded = False
        state.ignored = []
        state.failures = {}
        # A losing-streak pause ends here too, and the streak starts over:
        # counting the old losses again would pause it straight back.
        state.risk_block = None
        state.streak_since = time.time()
        self._ledgers.pop(link_id, None)
        self.state.save()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="copier-engine", daemon=True)
        self._thread.start()
        log.info("engine started (interval %.2fs)", self.poll_interval)

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread:
            thread.join(timeout=30)
        self._thread = None

    def _loop(self) -> None:
        with ThreadPoolExecutor(
            max_workers=self.max_parallel_links, thread_name_prefix="copier-link"
        ) as executor:
            while not self._stop.is_set():
                started = time.time()
                with self._lock:
                    active = [l for l in self.links.values() if l.enabled]
                if active:
                    # Links are independent; one broker stalling must not hold up
                    # the others. Exceptions are captured per link inside _safe_run.
                    list(executor.map(self._safe_run, active))
                    self.state.save()
                elapsed = time.time() - started
                self._stop.wait(max(0.05, self.poll_interval - elapsed))

    def _safe_run(self, link: Link) -> None:
        try:
            self.run_link(link)
        except (WorkerDown, CommandFailed, SourceUnavailable) as exc:
            self._note_cycle(link, error=str(exc))
            log.warning("link %s: %s", link.label, exc)
        except Exception as exc:  # a bug in one link must not stop the rest
            self._note_cycle(link, error=f"{type(exc).__name__}: {exc}")
            log.exception("link %s crashed", link.label)

    # -- events ------------------------------------------------------------

    def _emit(self, link: Link, kind: str, message: str, **extra: Any) -> None:
        with self._lock:
            self._sequence += 1
            event = {
                # A monotonic cursor, so a reader can ask for what it has not
                # seen without relying on clocks or re-reading the whole buffer.
                "seq": self._sequence,
                "at": time.time(),
                "linkId": link.id,
                "linkLabel": link.label,
                "ownerId": link.owner_id,
                "masterLabel": link.master.label,
                "destLabel": self._dest_label(link),
                "kind": kind,
                "message": message,
                "dryRun": link.dry_run,
                **extra,
            }
            self._events.append(event)
            del self._events[:-500]
        log.info("[%s]%s %s: %s", link.label, " (dry run)" if link.dry_run else "", kind, message)
        if self.on_event:
            try:
                self.on_event(event)
            except Exception:
                log.exception("event handler failed")

    def _note_cycle(self, link: Link, **fields: Any) -> None:
        with self._lock:
            entry = self._cycle.setdefault(link.id, {})
            entry.update(fields)
            entry["at"] = time.time()

    # -- caches ------------------------------------------------------------

    def _symbol_index(self, account_id: str, *, refresh: bool = False) -> SymbolIndex:
        cached = self._symbols.get(account_id)
        now = time.time()
        if cached and not refresh and now - cached[0] < SYMBOL_CACHE_TTL:
            return cached[1]
        result = self.pool.get(account_id).call("symbols", timeout=self.snapshot_timeout)
        index = SymbolIndex(result.get("symbols") or [])
        self._symbols[account_id] = (now, index)
        return index

    def _spec(self, account_id: str, symbol: str) -> dict[str, Any]:
        key = (account_id, symbol)
        cached = self._specs.get(key)
        now = time.time()
        if cached and now - cached[0] < SYMBOL_CACHE_TTL:
            return cached[1]
        spec = self.pool.get(account_id).call(
            "spec", {"symbol": symbol}, timeout=self.snapshot_timeout
        )
        self._specs[key] = (now, spec)
        return spec

    # -- the cycle ---------------------------------------------------------

    def run_link(self, link: Link) -> None:
        state = self.state.get(link.id)
        if state.halted_reason:
            self._note_cycle(link, halted=state.halted_reason)
            return

        try:
            master = self.masters.snapshot(link.master)
        except (SourceUnavailable, WorkerDown, CommandFailed) as exc:
            self._outage(link, state, "master", exc)
            raise
        try:
            dest = self.pool.get(link.dest_id).call("snapshot", timeout=self.snapshot_timeout)
        except (WorkerDown, CommandFailed) as exc:
            self._outage(link, state, "slave", exc)
            raise
        self._recovered(link)

        if not self._guards_pass(link, state, master, dest):
            return

        server_now = self._server_now(link, dest)
        self._roll_day(state, server_now)
        _stamp_execution_times(master)

        magic = link.magic
        owned = [p for p in dest["positions"] if int(p["magic"]) == magic]
        dest_by_ticket = {int(p["ticket"]): p for p in owned}
        master_by_ticket = {int(p["ticket"]): p for p in master["positions"]}

        # Snapshot the mapping so we can detect what disappeared after rebuild.
        pre_mapping = dict(state.mapping)

        self._rebuild_mapping(link, state, owned, dest_by_ticket)

        # Detect manually closed slave positions: a master ticket was in our
        # mapping before this cycle but its slave copy is now gone — even though
        # the master is still holding the trade.  That means the user closed it
        # on the slave side themselves.  Record it so we do not re-open it.
        for mt, dt in pre_mapping.items():
            if mt not in state.mapping and mt in master_by_ticket:
                if mt not in state.manual_closes:
                    state.manual_closes.add(mt)
                    self._emit(
                        link, "manual_close",
                        f"slave position #{dt} for master #{mt} was closed on the slave "
                        f"(by hand, or its own stop loss / take profit); will not re-copy "
                        f"while the master holds the trade open",
                        masterTicket=mt, ticket=dt,
                    )

        if not state.seeded:
            if not link.rules.copy_existing:
                # Anything already mapped is ours and stays managed; only
                # untracked master positions are written off.
                state.ignored = sorted(t for t in master_by_ticket if t not in state.mapping)
                if state.ignored:
                    self._emit(
                        link, "seeded",
                        f"ignoring {len(state.ignored)} position(s) already open on the master",
                        tickets=state.ignored,
                    )
            state.seeded = True
        # Forget ignored and manual-close tickets once the master closes them.
        state.ignored = [t for t in state.ignored if t in master_by_ticket]
        state.manual_closes = {t for t in state.manual_closes if t in master_by_ticket}

        self._close_orphans(link, state, master_by_ticket, dest_by_ticket)
        self._protect_open(link, state, dest_by_ticket)
        self._sync_open(link, state, master, dest, master_by_ticket, dest_by_ticket)
        self._update_ledger(link, state, dest_by_ticket, server_now)
        self._open_new(link, state, master, dest, master_by_ticket, dest_by_ticket, server_now)

        # Records of copies that are gone on both sides are no longer needed.
        for master_ticket in list(state.opened):
            if master_ticket not in state.mapping and master_ticket not in master_by_ticket:
                state.opened.pop(master_ticket, None)
                state.peaks.pop(master_ticket, None)

        self._note_cycle(
            link,
            error=None,
            masterPositions=len(master_by_ticket),
            copiedPositions=len(state.mapping),
            masterEquity=master["account"]["equity"],
            destEquity=dest["account"]["equity"],
        )

    # -- clock and risk limits ---------------------------------------------

    def _server_now(self, link: Link, dest: dict[str, Any]) -> float:
        """The destination broker's wall clock, as MT5 epoch seconds.

        Daily limits and sessions follow the broker's day, which is what its
        MT5 charts show. The worker estimates the offset from live quotes; when
        it cannot (a quiet market), the last known offset is kept.
        """
        offset = dest.get("serverOffset")
        if isinstance(offset, (int, float)):
            self._server_offsets[link.dest_id] = float(offset)
        return time.time() + self._server_offsets.get(link.dest_id, 0.0)

    @staticmethod
    def _roll_day(state: LinkState, server_now: float) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime(server_now))
        if state.day != day:
            state.day = day
            state.trades_today = 0
            state.notified = {}

    def _entry_block(
        self, link: Link, state: LinkState, server_now: float
    ) -> tuple[str, str, str, str] | None:
        """The risk limit stopping new copies right now, if any.

        Returns (trigger, limit name, what was hit, when copying resumes).
        """
        rules = link.rules
        if state.risk_block:
            return ("loss_streak", "Max consecutive losses", state.risk_block,
                    "when you arm the link again")
        daily = self._daily_loss_block(link, state)
        if daily:
            return daily
        closed = rules.session_closed_reason(server_now)
        if closed:
            resumes = (f"when the session opens at {rules.session_start} (server time)"
                       if rules.session_start else "on the next allowed day")
            return ("session", "Trading session", closed, resumes)
        if rules.max_trades_per_day and state.trades_today >= rules.max_trades_per_day:
            return ("trades_per_day", "Max trades per day",
                    f"{state.trades_today} of {rules.max_trades_per_day} copied today",
                    "at the broker's midnight")
        return None

    def _block(
        self,
        link: Link,
        state: LinkState,
        master_ticket: int,
        master_position: dict[str, Any],
        trigger: str,
        limit: str,
        detail: str,
        resumes: str,
    ) -> None:
        """Write a trade off because of a risk limit.

        Every blocked trade is logged; the limit itself is reported to Telegram
        once a day, so a busy master does not turn one limit into a flood.
        """
        symbol = master_position["symbol"]
        state.ignored.append(master_ticket)
        self._emit(
            link, "blocked",
            f"not copying master #{master_ticket} ({symbol}): {limit.lower()}: {detail}",
            masterTicket=master_ticket, masterSymbol=symbol, trigger=trigger,
        )
        self._risk_alert(
            link, state, trigger, limit, detail, resumes,
            masterTicket=master_ticket, masterSymbol=symbol,
            masterSide=master_position.get("side"), masterVolume=master_position.get("volume"),
        )

    def _risk_alert(
        self,
        link: Link,
        state: LinkState,
        trigger: str,
        limit: str,
        detail: str,
        resumes: str,
        **extra: Any,
    ) -> None:
        """Report a risk limit, at most once per limit per broker day."""
        if state.notified.get(trigger) == state.day:
            return
        state.notified[trigger] = state.day or ""
        self._emit(
            link, "risk",
            f"{limit}: {detail}. New trades are not copied; open copies are still managed.",
            trigger=trigger, limit=limit, detail=detail, resumes=resumes, **extra,
        )

    def _daily_loss_block(self, link: Link, state: LinkState) -> tuple[str, str, str, str] | None:
        limit = link.rules.max_daily_loss
        ledger = self._ledgers.get(link.id)
        if not limit or not ledger:
            return None
        total = ledger["realized"] + ledger.get("floating", 0.0)
        if total > -limit:
            return None
        return ("daily_loss", "Max daily loss",
                f"today's P/L {total:.2f} is past the -{limit:.2f} limit",
                "at the broker's midnight")

    def _update_ledger(
        self,
        link: Link,
        state: LinkState,
        dest_by_ticket: dict[int, dict[str, Any]],
        server_now: float,
    ) -> None:
        """Today's result and the current losing streak, from the slave's deals.

        Realized P/L comes from the slave's own deal history for this link's
        magic number, so copies closed by their stop loss, by hand or by the
        copier all count. Floating P/L of open copies is added every cycle.
        """
        rules = link.rules
        if not (rules.max_daily_loss > 0 or rules.max_consecutive_losses > 0):
            self._ledgers.pop(link.id, None)
            return
        now = time.time()
        floating = sum(
            float(p.get("profit") or 0) + float(p.get("swap") or 0) for p in dest_by_ticket.values()
        )
        key = (state.day, state.last_action_at, frozenset(dest_by_ticket))
        ledger = self._ledgers.get(link.id)
        if ledger is None or ledger["key"] != key or now - ledger["at"] >= LEDGER_REFRESH:
            offset = self._server_offsets.get(link.dest_id, 0.0)
            day_start = math.floor(server_now / 86_400) * 86_400
            streak_from = max(state.streak_since or 0.0, now - LEDGER_STREAK_WINDOW) + offset
            try:
                deals = self.pool.get(link.dest_id).call(
                    "deals", {"magic": link.magic, "since": int(min(day_start, streak_from))},
                    timeout=self.snapshot_timeout,
                ).get("deals") or []
            except (CommandFailed, WorkerDown) as exc:
                log.warning("link %s: could not read deal history: %s", link.label, exc)
                if ledger is None:
                    return
            else:
                ledger = {"key": key, "at": now, **_summarise_deals(
                    deals, day_start=day_start, streak_from=streak_from,
                    still_open=set(dest_by_ticket),
                )}
                self._ledgers[link.id] = ledger
        ledger["floating"] = floating

        if (rules.max_consecutive_losses and not state.risk_block
                and ledger["streak"] >= rules.max_consecutive_losses):
            state.risk_block = (f"{ledger['streak']} losing copies in a row "
                                f"(limit {rules.max_consecutive_losses})")
            self.state.save()
            self._risk_alert(link, state, "loss_streak", "Max consecutive losses",
                             state.risk_block, "when you arm the link again")
        daily = self._daily_loss_block(link, state)
        if daily:
            self._risk_alert(link, state, *daily, realized=round(ledger["realized"], 2),
                             floating=round(floating, 2))

    # -- exits the slave makes on its own ----------------------------------

    def _protect_open(
        self,
        link: Link,
        state: LinkState,
        dest_by_ticket: dict[int, dict[str, Any]],
    ) -> None:
        """Close copies on the slave's own terms: a money stop, or trailing.

        Both close the copy while the master may still be open, so the master
        ticket is marked like a hand-closed copy and is not copied again.
        """
        rules = link.rules
        trailing = rules.exit_mode == "TRAILING"
        if not (rules.max_loss_per_trade > 0 or trailing):
            return
        for master_ticket, ticket in list(state.mapping.items()):
            position = dest_by_ticket.get(ticket)
            if not position:
                continue
            pnl = float(position.get("profit") or 0) + float(position.get("swap") or 0)

            if rules.max_loss_per_trade > 0 and pnl <= -rules.max_loss_per_trade:
                self._exit_copy(
                    link, state, master_ticket, ticket, position, "loss_stop",
                    f"loss {pnl:.2f} reached the -{rules.max_loss_per_trade:.2f} limit per trade",
                    loss=round(pnl, 2), limit=rules.max_loss_per_trade,
                )
                continue

            if not trailing:
                continue
            peak = max(state.peaks.get(master_ticket, pnl), pnl)
            state.peaks[master_ticket] = peak
            if peak <= 0 or peak < rules.trail_activation:
                continue
            floor = peak * (1 - rules.trail_drawdown_pct / 100.0)
            if pnl <= floor:
                self._exit_copy(
                    link, state, master_ticket, ticket, position, "trailing_exit",
                    f"profit fell from a peak of {peak:.2f} to {pnl:.2f}, past the "
                    f"{rules.trail_drawdown_pct:g}% trailing allowance ({floor:.2f})",
                    peak=round(peak, 2), retracement=round(peak - floor, 2),
                    floor=round(floor, 2), exitProfit=round(pnl, 2),
                    drawdownPct=rules.trail_drawdown_pct, activation=rules.trail_activation,
                )

    def _exit_copy(
        self,
        link: Link,
        state: LinkState,
        master_ticket: int,
        ticket: int,
        position: dict[str, Any],
        kind: str,
        message: str,
        **extra: Any,
    ) -> None:
        reason = "trail" if kind == "trailing_exit" else "lossstop"
        if not self._close(link, ticket, reason=reason):
            return
        state.mapping.pop(master_ticket, None)
        state.manual_closes.add(master_ticket)  # the master may still hold it
        state.peaks.pop(master_ticket, None)
        state.last_action_at = time.time()
        self._emit(
            link, kind, f"closed #{ticket} for master #{master_ticket}: {message}",
            masterTicket=master_ticket, ticket=ticket, symbol=position.get("symbol"),
            side=position.get("side"), volume=position.get("volume"),
            profit=position.get("profit"), **extra,
        )
        self._journal_close(link, state, master_ticket, position,
                            "trailing exit" if kind == "trailing_exit" else "loss per trade")

    # -- measurements --------------------------------------------------------

    def _stamp_master_time(
        self, link: Link, master_position: dict[str, Any], seen_at: float
    ) -> None:
        """Put the master's execution time on our clock, learning its offset.

        A master read through the Manager API reports open times on its
        broker's clock and nothing else about that clock. But a new trade is
        seen within seconds of executing, so the gap between its broker time and
        our clock, rounded to the half hour, is the broker's offset. It is only
        learned from a trade seen promptly, and then kept.
        """
        if isinstance(master_position.get("executedAt"), (int, float)):
            return  # the source already knew its clock
        msc = master_position.get("openedAtMsc")
        if not isinstance(msc, (int, float)) or msc <= 0:
            return
        key = link.master.key
        offset = self._master_offsets.get(key)
        if offset is None:
            raw = msc / 1000.0 - seen_at
            rounded = round(raw / 1800) * 1800
            if abs(rounded) > 14 * 3600 or abs(raw - rounded) > MASTER_CLOCK_TOLERANCE:
                return
            offset = self._master_offsets[key] = float(rounded)
        master_position["executedAt"] = msc / 1000.0 - offset

    def _timing(
        self,
        link: Link,
        master_position: dict[str, Any],
        seen_at: float,
        sent_at: float,
        filled_at: float,
    ) -> dict[str, Any]:
        """How long each step of a copy took, in milliseconds.

        latency = slave fill - master execution. Detection (master execution to
        the copier seeing it) and execution (order sent to filled) are its two
        parts. The master's execution time is only known when its source
        reports it with milliseconds and its server clock offset.
        """
        timing: dict[str, Any] = {
            "seenAt": seen_at,
            "sentAt": sent_at,
            "filledAt": filled_at,
            "executionMs": round((filled_at - sent_at) * 1000),
        }
        executed = master_position.get("executedAt")
        if isinstance(executed, (int, float)) and executed > 0:
            timing["masterExecutedAt"] = executed
            timing["detectionMs"] = max(0, round((seen_at - executed) * 1000))
            timing["latencyMs"] = max(0, round((filled_at - executed) * 1000))
        return timing

    def _slippage_points(
        self,
        link: Link,
        dest_symbol: str,
        side: str,
        master_position: dict[str, Any],
        fill_price: Any,
    ) -> float | None:
        """How far the copy filled from the master's entry, in the slave's points.

        Positive is worse for the copy: paid more on a buy, got less on a sell.
        """
        spec = self._specs.get((link.dest_id, dest_symbol), (0, {}))[1]
        point = float(spec.get("point") or 0)
        master_price = float(master_position.get("priceOpen") or 0)
        try:
            fill = float(fill_price or 0)
        except (TypeError, ValueError):
            return None
        if not point or not master_price or not fill:
            return None
        diff = fill - master_price if side == "BUY" else master_price - fill
        return round(diff / point, 1)

    def _journal(self, link: Link, kind: str, master_ticket: int, record: dict[str, Any]) -> None:
        if self.journal is None:
            return
        try:
            self.journal.append({
                "kind": kind, "at": time.time(), "linkId": link.id, "linkLabel": link.label,
                "ownerId": link.owner_id, "masterLabel": link.master.label,
                "masterTicket": master_ticket, "dryRun": link.dry_run, **record,
            })
        except Exception:  # a journal problem must never stop copying
            log.exception("could not write the trade journal")

    # -- outages -----------------------------------------------------------

    def _outage(self, link: Link, state: LinkState, side: str, exc: Exception) -> None:
        """Note a failed read, and report it once it has lasted long enough."""
        now = time.time()
        with self._lock:
            outage = self._outages.get(link.id)
            if outage is None or outage["side"] != side:
                outage = {"side": side, "since": now, "reason": str(exc), "alerted": False}
                self._outages[link.id] = outage
            outage["reason"] = str(exc)
            due = not outage["alerted"] and now - outage["since"] >= OUTAGE_ALERT_AFTER
            if due:
                outage["alerted"] = True
        if due:
            who = "master" if side == "master" else "slave"
            self._emit(
                link, "outage",
                f"cannot read the {who} account since "
                f"{time.strftime('%H:%M:%S', time.localtime(outage['since']))}: {exc}",
                account=side, since=outage["since"], reason=str(exc),
                openCopies=len(state.mapping),
            )

    def _recovered(self, link: Link) -> None:
        """Both sides read fine: close out an outage, reporting it if it was."""
        with self._lock:
            outage = self._outages.pop(link.id, None)
        if outage and outage["alerted"]:
            self._emit(
                link, "recovered",
                f"the {outage['side']} account is readable again after "
                f"{_duration(time.time() - outage['since'])}",
                account=outage["side"], since=outage["since"],
                downSeconds=round(time.time() - outage["since"]),
            )

    # -- guards ------------------------------------------------------------

    def _halt(self, link: Link, state: LinkState, reason: str) -> None:
        state.halted_reason = reason
        self.state.save()
        self._emit(link, "halted", reason)

    def _guards_pass(
        self, link: Link, state: LinkState, master: dict[str, Any], dest: dict[str, Any]
    ) -> bool:
        account = dest["account"]
        if not account.get("tradeAllowed"):
            self._halt(link, state, "the destination account is not allowed to trade")
            return False
        if not account.get("hedging"):
            self._halt(
                link, state,
                "the destination account is netting, not hedging; copies of separate "
                "master trades would merge into one position and closes would hit the "
                "wrong trade",
            )
            return False

        if link.max_drawdown_pct > 0:
            equity = float(account["equity"])
            if state.baseline_equity is None:
                state.baseline_equity = equity
                self.state.save()
            baseline = float(state.baseline_equity or 0)
            if baseline > 0:
                drawdown = (baseline - equity) / baseline * 100.0
                if drawdown >= link.max_drawdown_pct:
                    self._flatten(link, state, reason="drawdown guard")
                    self._halt(
                        link, state,
                        f"destination equity fell {drawdown:.2f}% from {baseline:.2f} "
                        f"to {equity:.2f}, past the {link.max_drawdown_pct:.2f}% limit",
                    )
                    return False
        return True

    # -- mapping -----------------------------------------------------------

    def _rebuild_mapping(
        self,
        link: Link,
        state: LinkState,
        owned: list[dict[str, Any]],
        dest_by_ticket: dict[int, dict[str, Any]],
    ) -> None:
        """Recover master->destination pairs from what is actually open.

        The comment on each copied position is the source of truth, so the
        mapping survives losing the state file. Entries from the file are kept
        only when the comment did not identify the position (some brokers
        rewrite comments) and the destination position still exists.
        """
        recovered: dict[int, int] = {}
        duplicates: list[dict[str, Any]] = []
        for position in owned:
            master_ticket = parse_master_ticket(position.get("comment", ""))
            if master_ticket is None:
                continue
            ticket = int(position["ticket"])
            if master_ticket in recovered:
                # Two copies of one master trade: an earlier open was recorded
                # late and retried. Keep the first, close the surplus.
                duplicates.append(position)
                continue
            recovered[master_ticket] = ticket

        claimed = set(recovered.values())
        for master_ticket, ticket in state.mapping.items():
            if master_ticket in recovered or ticket in claimed:
                continue
            if ticket in dest_by_ticket:
                recovered[master_ticket] = ticket
                claimed.add(ticket)
        state.mapping = recovered

        for position in duplicates:
            self._emit(
                link, "duplicate",
                f"closing a duplicate copy of master #{parse_master_ticket(position['comment'])} "
                f"({position['symbol']} {position['volume']})",
                ticket=position["ticket"],
            )
            self._close(link, int(position["ticket"]), reason="duplicate")

    # -- actions -----------------------------------------------------------

    def _close(self, link: Link, ticket: int, *, volume: float | None = None, reason: str = "") -> bool:
        """Close (part of) a copy. A failing close is retried with growing
        pauses, and each distinct failure is reported once."""
        if link.dry_run:
            return True
        key = (link.id, ticket)
        failure = self._close_failures.get(key)
        if failure and time.time() < failure["nextTry"]:
            return False
        args: dict[str, Any] = {"ticket": ticket, "comment": f"c{reason}"[:31],
                                "deviation": link.rules.max_slippage_points}
        if volume is not None:
            args["volume"] = volume
        try:
            self.pool.get(link.dest_id).call("close", args, timeout=self.order_timeout)
        except (CommandFailed, WorkerDown) as exc:
            attempts = int((failure or {}).get("attempts", 0)) + 1
            delay = CLOSE_RETRY_BACKOFF[min(attempts - 1, len(CLOSE_RETRY_BACKOFF) - 1)]
            self._close_failures[key] = {
                "attempts": attempts, "nextTry": time.time() + delay, "reason": str(exc),
            }
            if not failure or failure.get("reason") != str(exc):
                self._emit(link, "error", f"could not close #{ticket}: {exc}", ticket=ticket)
            return False
        self._close_failures.pop(key, None)
        return True

    def _flatten(self, link: Link, state: LinkState, *, reason: str) -> None:
        """Close every position this link owns on the destination."""
        for master_ticket, ticket in list(state.mapping.items()):
            if self._close(link, ticket, reason=reason[:8]):
                state.mapping.pop(master_ticket, None)
        self.state.save()

    def _close_orphans(
        self,
        link: Link,
        state: LinkState,
        master_by_ticket: dict[int, dict[str, Any]],
        dest_by_ticket: dict[int, dict[str, Any]],
    ) -> None:
        """The master closed a trade, so close ours.

        Reported once the copy is actually closed: announcing it first used to
        repeat the alert on every cycle for as long as the close kept failing.
        """
        for master_ticket, ticket in list(state.mapping.items()):
            if master_ticket in master_by_ticket:
                continue
            position = dest_by_ticket.get(ticket, {})
            if not self._close(link, ticket, reason="master"):
                continue
            state.mapping.pop(master_ticket, None)
            state.last_action_at = time.time()
            self._emit(
                link, "close",
                f"master closed #{master_ticket}; closed {position.get('symbol', '?')} "
                f"{position.get('volume', '?')} (#{ticket})",
                masterTicket=master_ticket, ticket=ticket,
                symbol=position.get("symbol"), side=position.get("side"),
                volume=position.get("volume"), profit=position.get("profit"),
            )
            self._journal_close(link, state, master_ticket, position, "master closed")

    def _journal_close(
        self, link: Link, state: LinkState, master_ticket: int, position: dict[str, Any], reason: str
    ) -> None:
        record = state.opened.get(master_ticket, {})
        self._journal(link, "close", master_ticket, {
            **record,
            "closeReason": reason,
            "closedAt": time.time(),
            "closePrice": position.get("priceCurrent"),
            "profit": position.get("profit"),
            "swap": position.get("swap"),
            "volume": position.get("volume", record.get("volume")),
        })

    def _skip(
        self,
        link: Link,
        state: LinkState,
        master_ticket: int,
        master_position: dict[str, Any],
        reason: str,
        now: float,
        *,
        refresh: dict[str, Any] | None = None,
    ) -> None:
        """Record a skip, reporting it only when it is news.

        Skips are retried on a backoff, and saying the same thing every retry
        buries everything else in the activity log.
        """
        symbol = master_position["symbol"]
        previous = (state.failures.get(master_ticket) or {}).get("reason")
        state.record_failure(master_ticket, reason, now)
        if previous != reason:
            self._emit(
                link, "skipped",
                f"not copying master #{master_ticket} ({symbol}): {reason}",
                masterTicket=master_ticket, masterSymbol=symbol,
                masterSide=master_position.get("side"),
                masterVolume=master_position.get("volume"),
                reason=reason,
                **({"refresh": refresh} if refresh else {}),
            )

    def _resolve_and_size(
        self,
        link: Link,
        master_position: dict[str, Any],
        master_account: dict[str, Any],
        dest_account: dict[str, Any],
        index: SymbolIndex,
    ) -> tuple[str, float]:
        """Translate the symbol and size the order, against the live terminal.

        Both steps can fail because of a stale symbol list, so they are raised
        as one kind of error the caller can retry after refreshing.
        """
        symbol = master_position["symbol"]
        try:
            dest_symbol = link.rules.resolve_symbol(symbol, index)
        except RuleError as exc:
            raise SymbolLookupFailed(str(exc)) from exc
        try:
            spec = self._spec(link.dest_id, dest_symbol)
            self._check_trade_mode(link, master_position, dest_symbol, spec)
            volume = self._target_volume(
                link, master_position, master_account, dest_account, dest_symbol
            )
        except CommandFailed as exc:
            # The worker could not find or select it — that answer is authoritative.
            if exc.code in {"SYMBOL_UNKNOWN", "SYMBOL_UNAVAILABLE"}:
                raise SymbolLookupFailed(
                    f"{dest_symbol} is not tradable on the destination", dest_symbol=dest_symbol
                ) from exc
            raise
        except RuleError as exc:
            raise SymbolLookupFailed(str(exc), dest_symbol=dest_symbol, sizing=True) from exc
        return dest_symbol, volume

    def _check_trade_mode(
        self, link: Link, master_position: dict[str, Any], dest_symbol: str, spec: dict[str, Any]
    ) -> None:
        """A listed symbol can still refuse new trades; say so before sending one."""
        mode = spec.get("tradeMode")
        if mode in _CLOSED_TRADE_MODES:
            raise SymbolLookupFailed(
                f"{dest_symbol} is not tradable on the destination "
                f"(the broker has {_CLOSED_TRADE_MODES[mode]} trading on it)",
                dest_symbol=dest_symbol,
            )
        only = _ONE_WAY_TRADE_MODES.get(mode)
        side = link.rules.side_for(master_position["side"])
        if only and side != only:
            raise SymbolLookupFailed(
                f"{dest_symbol} only accepts {only} trades on the destination, not {side}",
                dest_symbol=dest_symbol,
            )

    def _resolve_for_open(
        self,
        link: Link,
        master_position: dict[str, Any],
        master: dict[str, Any],
        dest: dict[str, Any],
        cycle: dict[str, Any],
    ) -> tuple[str, float, dict[str, Any] | None]:
        """Resolve and size a new copy, trying harder before calling a symbol missing.

        First the symbol list is re-read (once per cycle). If the terminal still
        does not know the instrument, the destination is logged in again, which
        is what makes a terminal pick up a symbol the broker enabled after it
        connected. Returns what that refresh found, if one was needed.
        """
        args = (link, master_position, master["account"], dest["account"])
        try:
            return (*self._resolve_and_size(*args, cycle["index"]), None)
        except SymbolLookupFailed as exc:
            failure = exc
        if failure.sizing:
            raise failure

        if not cycle["list_refreshed"]:
            cycle["list_refreshed"] = True
            cycle["index"] = self._symbol_index(link.dest_id, refresh=True)
            try:
                return (*self._resolve_and_size(*args, cycle["index"]), None)
            except SymbolLookupFailed as exc:
                failure = exc

        refresh = self._refresh_account(link, failure.dest_symbol, master_position["symbol"])
        if refresh is None:
            raise failure
        if refresh.get("ok"):
            try:
                cycle["index"] = self._symbol_index(link.dest_id, refresh=True)
                return (*self._resolve_and_size(*args, cycle["index"]), refresh)
            except SymbolLookupFailed as exc:
                failure = exc
        failure.refresh = refresh
        raise failure

    def _refresh_account(
        self, link: Link, dest_symbol: str | None, master_symbol: str
    ) -> dict[str, Any] | None:
        """Log the destination in again, at most as often as the cooldowns allow.

        Returns None when a refresh was not attempted because one ran recently.
        """
        now = time.time()
        key = (link.dest_id, dest_symbol or master_symbol)
        with self._lock:
            if now - self._account_refreshed.get(link.dest_id, 0.0) < ACCOUNT_REFRESH_GAP:
                return None
            if now - self._symbol_refreshed.get(key, 0.0) < SYMBOL_REFRESH_COOLDOWN:
                return None
            self._account_refreshed[link.dest_id] = now
            self._symbol_refreshed[key] = now

        try:
            result = self.pool.get(link.dest_id).call(
                "refresh", {"symbol": dest_symbol} if dest_symbol else {}, timeout=REFRESH_TIMEOUT
            )
            note: dict[str, Any] = {"ok": True, **result}
        except (CommandFailed, WorkerDown) as exc:
            note = {"ok": False, "error": str(exc), "symbol": dest_symbol}

        # Whatever happened, what we cached about this account may be stale now.
        self._symbols.pop(link.dest_id, None)
        for cached in list(self._specs):
            if cached[0] == link.dest_id:
                self._specs.pop(cached, None)

        self._emit(link, "refreshed", _describe_refresh(note), refresh=note)
        return note

    def _target_volume(
        self,
        link: Link,
        master_position: dict[str, Any],
        master_account: dict[str, Any],
        dest_account: dict[str, Any],
        dest_symbol: str,
    ) -> float:
        if link.rules.lot_mode == "RISK_PERCENT":
            # Sized so that the master's stop, if hit, costs the chosen share of
            # the slave's equity. The stop distance is the master's own.
            spec = self._spec(link.dest_id, dest_symbol)
            raw = link.rules.risk_volume(
                dest_equity=float(dest_account["equity"]),
                entry=float(master_position.get("priceOpen") or 0),
                stop=float(master_position.get("sl") or 0),
                tick_size=float(spec.get("tickSize") or 0),
                tick_value=float(spec.get("tickValue") or 0),
            )
            return link.rules.round_volume(raw, spec)
        raw = link.rules.scale_volume(
            float(master_position["volume"]),
            master_balance=float(master_account["balance"]),
            dest_balance=float(dest_account["balance"]),
            master_equity=float(master_account["equity"]),
            dest_equity=float(dest_account["equity"]),
        )
        spec = self._spec(link.dest_id, dest_symbol)
        return link.rules.round_volume(raw, spec)

    def _sync_open(
        self,
        link: Link,
        state: LinkState,
        master: dict[str, Any],
        dest: dict[str, Any],
        master_by_ticket: dict[int, dict[str, Any]],
        dest_by_ticket: dict[int, dict[str, Any]],
    ) -> None:
        """Keep matched pairs in step: partial closes and stop changes."""
        for master_ticket, ticket in list(state.mapping.items()):
            master_position = master_by_ticket.get(master_ticket)
            dest_position = dest_by_ticket.get(ticket)
            if not master_position or not dest_position:
                continue

            symbol = dest_position["symbol"]
            current = float(dest_position["volume"])
            master_volume = float(master_position["volume"])

            # The sizes at the moment of copying are the yardstick. Re-running
            # the lot formula instead would let an equity or balance ratio that
            # drifted since then "reduce" a copy the master never touched, and
            # would never reduce a fixed-lot copy at all.
            # A copy made before sizes were recorded starts its record now.
            record = state.opened.get(master_ticket) or {}
            if not record.get("masterVolume"):
                record = {**record, "masterVolume": master_volume, "volume": current}
                state.opened[master_ticket] = record
            base_master = float(record["masterVolume"])
            base_copy = float(record.get("volume") or current)

            if master_volume < base_master - 1e-9:
                try:
                    spec = self._spec(link.dest_id, symbol)
                except (CommandFailed, WorkerDown) as exc:
                    log.debug("cannot size %s: %s", symbol, exc)
                    continue
                step = float(spec.get("volumeStep") or 0.01)
                vol_min = float(spec.get("volumeMin") or step)
                target = math.floor(round(base_copy * master_volume / base_master / step, 9)) * step
                target = round(target, 8)
                if target < vol_min:
                    # Cannot go below the minimum while the master still holds
                    # some: keep the smallest allowed lot.
                    target = min(current, vol_min)
                # Only ever reduce: a hedging account cannot grow a position, and
                # a top-up would need a second ticket that breaks the 1:1 mapping.
                if current - target >= step / 2:
                    self._emit(
                        link, "reduce",
                        f"master reduced #{master_ticket} from {base_master:g} to "
                        f"{master_volume:g}; trimming {symbol} from {current:g} to "
                        f"{target:g} (#{ticket})",
                        masterTicket=master_ticket, ticket=ticket, symbol=symbol,
                        side=dest_position.get("side"), volume=target, fromVolume=current,
                        masterVolume=master_volume, masterFromVolume=base_master,
                    )
                    self._close(link, ticket, volume=round(current - target, 8), reason="reduce")
                    state.last_action_at = time.time()
                    continue

            if not link.rules.follows_stops:
                continue
            sl, tp = link.rules.stops_for(master_position["sl"], master_position["tp"])
            # A level this link does not copy stays whatever the slave has.
            if not link.rules.copy_sl:
                sl = float(dest_position["sl"])
            if not link.rules.copy_tp:
                tp = float(dest_position["tp"])
            spec = self._specs.get((link.dest_id, symbol), (0, {}))[1]
            digits = int(spec.get("digits") or 5)
            if (round(float(dest_position["sl"]), digits) == round(sl, digits)
                    and round(float(dest_position["tp"]), digits) == round(tp, digits)):
                self._stop_failures.pop((link.id, ticket), None)
                continue

            # The slave refused these exact levels before (usually its minimum
            # stop distance). Retrying every second would only repeat the alert.
            wanted = (round(sl, digits), round(tp, digits))
            failed = self._stop_failures.get((link.id, ticket))
            if failed and failed[0] == wanted and time.time() < failed[1]:
                continue

            self._emit(
                link, "modify",
                f"master moved the stops on #{master_ticket}; setting SL {sl or '-'} "
                f"TP {tp or '-'} on {symbol} (#{ticket})",
                masterTicket=master_ticket, ticket=ticket, sl=sl, tp=tp,
            )
            if link.dry_run:
                continue
            try:
                self.pool.get(link.dest_id).call(
                    "modify", {"ticket": ticket, "sl": sl, "tp": tp}, timeout=self.order_timeout
                )
                state.last_action_at = time.time()
                self._stop_failures.pop((link.id, ticket), None)
            except (CommandFailed, WorkerDown) as exc:
                # Usually the destination's stop distance rule. Not fatal: the
                # position stays open, just without the copied stops. Reported
                # once per set of levels, retried after a pause.
                if not failed or failed[0] != wanted:
                    self._emit(
                        link, "error",
                        f"could not set stops on #{ticket} ({symbol}): {exc}",
                        ticket=ticket,
                    )
                self._stop_failures[(link.id, ticket)] = (wanted, time.time() + STOP_RETRY_AFTER)

    def _open_new(
        self,
        link: Link,
        state: LinkState,
        master: dict[str, Any],
        dest: dict[str, Any],
        master_by_ticket: dict[int, dict[str, Any]],
        dest_by_ticket: dict[int, dict[str, Any]],
        server_now: float,
    ) -> None:
        ignored = set(state.ignored)
        now = time.time()
        cycle = {"index": self._symbol_index(link.dest_id), "list_refreshed": False}
        open_count = len(dest_by_ticket)
        # Lots this link holds per direction, for the exposure limits. Kept up
        # to date as copies are placed in this same cycle.
        exposure = {"BUY": 0.0, "SELL": 0.0}
        for position in dest_by_ticket.values():
            exposure[str(position.get("side", "BUY")).upper()] += float(position["volume"])

        # A dry run reports each trade once, then forgets it when the master
        # closes it.
        for key in [k for k in self._dry_seen if k[0] == link.id and k[1] not in master_by_ticket]:
            self._dry_seen.discard(key)
        for key in [k for k in self._first_seen if k[0] == link.id and k[1] not in master_by_ticket]:
            self._first_seen.pop(key, None)

        # Oldest first, so a position cap fills in the order the master traded.
        # MT5 hands out tickets in order, and the Manager API gives no usable
        # open time, so the ticket is the age.
        for master_ticket in sorted(master_by_ticket):
            if master_ticket in state.mapping or master_ticket in ignored:
                continue
            if master_ticket in state.manual_closes:
                continue  # closed on the slave already — do not re-open
            if link.dry_run and (link.id, master_ticket) in self._dry_seen:
                continue
            master_position = master_by_ticket[master_ticket]
            symbol = master_position["symbol"]
            seen_at = self._first_seen.setdefault((link.id, master_ticket), now)
            self._stamp_master_time(link, master_position, seen_at)

            filtered = link.rules.filter_reason(symbol)
            if filtered:
                # Permanent for this trade, so it is written off rather than
                # retried — but never silently: a filter nobody can see looks
                # exactly like a copier that has stopped working.
                state.ignored.append(master_ticket)
                self._emit(
                    link, "filtered",
                    f"not copying master #{master_ticket} ({symbol}): {filtered}",
                    masterTicket=master_ticket, symbol=symbol,
                )
                continue
            if not state.should_retry(master_ticket, now):
                continue

            # Risk limits that stop new copies outright. A trade they block is
            # written off, not queued: copying it once the block lifts would
            # enter late, at a price the master never paid.
            block = self._entry_block(link, state, server_now)
            if block:
                self._block(link, state, master_ticket, master_position, *block)
                continue

            cap = link.rules.max_open_positions
            if cap and open_count >= cap:
                state.record_failure(master_ticket, f"destination is at its {cap}-position limit", now)
                continue

            try:
                # The list we matched against may simply not have caught up with
                # the broker yet, so this re-reads it, and then logs the account
                # in again, before believing an instrument is unavailable.
                dest_symbol, volume, refresh = self._resolve_for_open(
                    link, master_position, master, dest, cycle
                )
            except SymbolLookupFailed as exc:
                self._skip(link, state, master_ticket, master_position, str(exc), now,
                           refresh=exc.refresh)
                continue
            except (CommandFailed, WorkerDown, SourceUnavailable) as exc:
                self._skip(link, state, master_ticket, master_position, str(exc), now)
                continue

            if volume <= 0:
                spec = self._specs.get((link.dest_id, dest_symbol), (0, {}))[1]
                self._skip(
                    link, state, master_ticket, master_position,
                    f"the scaled lot is below the {dest_symbol} minimum of {spec.get('volumeMin')}",
                    now,
                )
                continue

            side = link.rules.side_for(master_position["side"])
            limit = link.rules.max_buy_lots if side == "BUY" else link.rules.max_sell_lots
            if limit > 0 and exposure[side] + volume > limit + 1e-9:
                self._block(
                    link, state, master_ticket, master_position,
                    f"exposure_{side.lower()}", f"Max {side} exposure",
                    f"{exposure[side]:g} + {volume:g} lots would exceed the {limit:g}-lot limit",
                    "as soon as open copies bring it under the limit",
                )
                continue

            sl, tp = link.rules.stops_for(master_position["sl"], master_position["tp"])
            self._emit(
                link, "open",
                f"master opened #{master_ticket} {master_position['side']} {symbol} "
                f"{master_position['volume']}; copying as {side} {dest_symbol} {volume}",
                masterTicket=master_ticket, symbol=dest_symbol, side=side, volume=volume,
            )

            if link.dry_run:
                # Announced once, with the same alert a real copy sends, so a
                # dry run can be checked from Telegram before going live.
                self._dry_seen.add((link.id, master_ticket))
                open_count += 1
                exposure[side] += volume
                state.trades_today += 1
                self._emit(
                    link, "opened",
                    f"dry run: would copy master #{master_ticket} as {side} {dest_symbol} {volume}",
                    masterTicket=master_ticket, symbol=dest_symbol, side=side, volume=volume,
                    masterSymbol=symbol, masterSide=master_position["side"],
                    masterVolume=float(master_position["volume"]),
                    **({"refresh": refresh} if refresh else {}),
                )
                continue

            sent_at = time.time()
            try:
                result = self.pool.get(link.dest_id).call("open", {
                    "symbol": dest_symbol,
                    "side": side,
                    "volume": volume,
                    "sl": sl,
                    "tp": tp,
                    "magic": link.magic,
                    "comment": f"c{master_ticket}",
                    "deviation": link.rules.max_slippage_points,
                }, timeout=self.order_timeout)
            except (CommandFailed, WorkerDown) as exc:
                state.record_failure(master_ticket, str(exc), now)
                self._emit(
                    link, "error",
                    f"could not copy master #{master_ticket} ({dest_symbol} {volume}): {exc}",
                    masterTicket=master_ticket,
                )
                continue

            # For a market order on a hedging account the position ticket is the
            # order ticket. If that ever differs, next cycle's comment recovery
            # corrects the mapping before anything acts on it.
            filled_at = time.time()
            ticket = int(result.get("order") or 0)
            if ticket:
                state.mapping[master_ticket] = ticket
            filled_volume = float(result.get("volume") or volume)
            timing = self._timing(link, master_position, seen_at, sent_at, filled_at)
            slippage = self._slippage_points(
                link, dest_symbol, side, master_position, result.get("price"))
            state.opened[master_ticket] = {
                "masterVolume": float(master_position["volume"]),
                "volume": filled_volume,
                "symbol": dest_symbol,
                "side": side,
                "price": result.get("price"),
                "masterPrice": master_position.get("priceOpen"),
                "masterSymbol": symbol,
                "ticket": ticket,
                **timing,
                **({"slippagePoints": slippage} if slippage is not None else {}),
            }
            self._first_seen.pop((link.id, master_ticket), None)
            state.clear_failure(master_ticket)
            state.copied_count += 1
            state.trades_today += 1
            state.last_action_at = filled_at
            open_count += 1
            exposure[side] += filled_volume
            self._emit(
                link, "opened",
                f"copied master #{master_ticket} as #{ticket} "
                f"({dest_symbol} {side} {volume} at {result.get('price')})",
                masterTicket=master_ticket, ticket=ticket, price=result.get("price"),
                symbol=dest_symbol, side=side, volume=filled_volume,
                masterSymbol=symbol, masterSide=master_position["side"],
                masterVolume=float(master_position["volume"]),
                masterPrice=master_position.get("priceOpen"),
                **timing,
                **({"slippagePoints": slippage} if slippage is not None else {}),
                **({"refresh": refresh} if refresh else {}),
            )
            self._journal(link, "open", master_ticket, state.opened[master_ticket])
        self.state.save()

    # -- introspection -----------------------------------------------------

    @property
    def sequence(self) -> int:
        """Highest event number emitted so far."""
        with self._lock:
            return self._sequence

    def _dest_label(self, link: Link) -> str:
        try:
            return self.pool.get(link.dest_id).account.label
        except Exception:
            return link.dest_id

    def events(self, limit: int = 100, since: int = -1) -> list[dict[str, Any]]:
        """Newest first, or oldest first when following a cursor.

        A follower wants them in the order they happened; a reader showing a
        feed wants the newest at the top. Zero is a real cursor position — it
        is where a freshly restarted copier starts — so "no cursor" has to be
        a separate value, or a restart would replay the whole buffer backwards.
        """
        with self._lock:
            if since >= 0:
                return [e for e in self._events if e.get("seq", 0) > since][:limit]
            return self._events[-limit:][::-1]

    def status(self) -> dict[str, Any]:
        with self._lock:
            links = list(self.links.values())
            cycles = dict(self._cycle)
        out = []
        for link in links:
            state = self.state.get(link.id)
            out.append({
                **link.to_dict(),
                "state": {
                    "seeded": state.seeded,
                    "copiedPositions": len(state.mapping),
                    "ignored": len(state.ignored),
                    "failures": {str(k): v for k, v in state.failures.items()},
                    "haltedReason": state.halted_reason,
                    "copiedCount": state.copied_count,
                    "lastActionAt": state.last_action_at,
                    "baselineEquity": state.baseline_equity,
                    # Risk: the broker day the counters belong to, what today
                    # looks like, and a losing-streak pause if one is on.
                    "day": state.day,
                    "tradesToday": state.trades_today,
                    "riskBlock": state.risk_block,
                    "today": _ledger_view(self._ledgers.get(link.id)),
                },
                "cycle": cycles.get(link.id, {}),
            })
        return {
            "running": bool(self._thread and self._thread.is_alive()),
            "pollInterval": self.poll_interval,
            "accounts": self.pool.statuses(),
            "links": out,
        }
