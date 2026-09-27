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


class SymbolLookupFailed(Exception):
    """A master symbol could not be translated to a tradable destination one."""


def magic_for(link_id: str) -> int:
    """Stable per-link magic number derived from the link id."""
    return MAGIC_PREFIX | (zlib.crc32(link_id.encode()) & 0x00FFFFFF)


def parse_master_ticket(comment: str) -> int | None:
    match = COMMENT_RE.search(comment or "")
    return int(match.group(1)) if match else None


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

        master = self.masters.snapshot(link.master)
        dest = self.pool.get(link.dest_id).call("snapshot", timeout=self.snapshot_timeout)

        if not self._guards_pass(link, state, master, dest):
            return

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
                        f"slave position #{dt} for master #{mt} was manually closed; "
                        f"will not re-copy while master holds the trade open",
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
        self._sync_open(link, state, master, dest, master_by_ticket, dest_by_ticket)
        self._open_new(link, state, master, dest, master_by_ticket, len(dest_by_ticket))

        self._note_cycle(
            link,
            error=None,
            masterPositions=len(master_by_ticket),
            copiedPositions=len(state.mapping),
            masterEquity=master["account"]["equity"],
            destEquity=dest["account"]["equity"],
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
        if link.dry_run:
            return True
        args: dict[str, Any] = {"ticket": ticket, "comment": f"c{reason}"[:31],
                                "deviation": link.rules.max_slippage_points}
        if volume is not None:
            args["volume"] = volume
        try:
            self.pool.get(link.dest_id).call("close", args, timeout=self.order_timeout)
            return True
        except (CommandFailed, WorkerDown) as exc:
            self._emit(link, "error", f"could not close #{ticket}: {exc}", ticket=ticket)
            return False

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
        """The master closed a trade, so close ours."""
        for master_ticket, ticket in list(state.mapping.items()):
            if master_ticket in master_by_ticket:
                continue
            position = dest_by_ticket.get(ticket, {})
            self._emit(
                link, "close",
                f"master closed #{master_ticket}; closing {position.get('symbol', '?')} "
                f"{position.get('volume', '?')} (#{ticket})",
                masterTicket=master_ticket, ticket=ticket,
                symbol=position.get("symbol"), side=position.get("side"),
                volume=position.get("volume"), profit=position.get("profit"),
            )
            if self._close(link, ticket, reason="master"):
                state.mapping.pop(master_ticket, None)
                state.last_action_at = time.time()

    def _skip(
        self,
        link: Link,
        state: LinkState,
        master_ticket: int,
        symbol: str,
        reason: str,
        now: float,
    ) -> None:
        """Record a skip, reporting it only when it is news.

        Skips are retried on a backoff, and saying the same thing every retry
        buries everything else in the activity log.
        """
        previous = (state.failures.get(master_ticket) or {}).get("reason")
        state.record_failure(master_ticket, reason, now)
        if previous != reason:
            self._emit(
                link, "skipped",
                f"not copying master #{master_ticket} ({symbol}): {reason}",
                masterTicket=master_ticket,
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
            volume = self._target_volume(
                link, master_position, master_account, dest_account, dest_symbol
            )
        except CommandFailed as exc:
            # The worker could not find or select it — that answer is authoritative.
            if exc.code in {"SYMBOL_UNKNOWN", "SYMBOL_UNAVAILABLE"}:
                raise SymbolLookupFailed(f"{dest_symbol} is not tradable on the destination") from exc
            raise
        except RuleError as exc:
            raise SymbolLookupFailed(str(exc)) from exc
        return dest_symbol, volume

    def _target_volume(
        self,
        link: Link,
        master_position: dict[str, Any],
        master_account: dict[str, Any],
        dest_account: dict[str, Any],
        dest_symbol: str,
    ) -> float:
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
            try:
                target = self._target_volume(
                    link, master_position, master["account"], dest["account"], symbol
                )
            except (RuleError, CommandFailed, WorkerDown, SourceUnavailable) as exc:
                log.debug("cannot size %s: %s", symbol, exc)
                continue

            spec = self._specs.get((link.dest_id, symbol), (0, {}))[1]
            step = float(spec.get("volumeStep") or 0.01)
            current = float(dest_position["volume"])
            # Only ever reduce: a hedging account cannot grow a position, and a
            # top-up would need a second ticket that breaks the 1:1 mapping.
            if target > 0 and current - target >= step / 2:
                self._emit(
                    link, "reduce",
                    f"master reduced #{master_ticket}; trimming {symbol} "
                    f"from {current} to {target} (#{ticket})",
                    masterTicket=master_ticket, ticket=ticket,
                )
                self._close(link, ticket, volume=round(current - target, 8), reason="reduce")
                state.last_action_at = time.time()
                continue

            if not link.rules.copy_sl_tp:
                continue
            sl, tp = link.rules.stops_for(master_position["sl"], master_position["tp"])
            digits = int(spec.get("digits") or 5)
            if (round(float(dest_position["sl"]), digits) == round(sl, digits)
                    and round(float(dest_position["tp"]), digits) == round(tp, digits)):
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
            except (CommandFailed, WorkerDown) as exc:
                # Usually the destination's stop distance rule. Not fatal: the
                # position stays open, just without the copied stops.
                self._emit(
                    link, "error",
                    f"could not set stops on #{ticket} ({symbol}): {exc}",
                    ticket=ticket,
                )

    def _open_new(
        self,
        link: Link,
        state: LinkState,
        master: dict[str, Any],
        dest: dict[str, Any],
        master_by_ticket: dict[int, dict[str, Any]],
        open_count: int,
    ) -> None:
        ignored = set(state.ignored)
        now = time.time()
        index = self._symbol_index(link.dest_id)
        refreshed = False

        # Oldest first, so a position cap fills in the order the master traded.
        # MT5 hands out tickets in order, and the Manager API gives no usable
        # open time, so the ticket is the age.
        for master_ticket in sorted(master_by_ticket):
            if master_ticket in state.mapping or master_ticket in ignored:
                continue
            if master_ticket in state.manual_closes:
                continue  # user closed this on the slave — do not re-open
            master_position = master_by_ticket[master_ticket]
            symbol = master_position["symbol"]

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
            cap = link.rules.max_open_positions
            if cap and open_count >= cap:
                state.record_failure(master_ticket, f"destination is at its {cap}-position limit", now)
                continue

            try:
                dest_symbol, volume = self._resolve_and_size(
                    link, master_position, master["account"], dest["account"], index
                )
            except SymbolLookupFailed as exc:
                # The list we matched against may simply not have caught up with
                # the broker yet, so re-read it once per cycle before believing
                # an instrument is unavailable.
                if refreshed:
                    self._skip(link, state, master_ticket, symbol, str(exc), now)
                    continue
                refreshed = True
                index = self._symbol_index(link.dest_id, refresh=True)
                try:
                    dest_symbol, volume = self._resolve_and_size(
                        link, master_position, master["account"], dest["account"], index
                    )
                except SymbolLookupFailed as retry_exc:
                    self._skip(link, state, master_ticket, symbol, str(retry_exc), now)
                    continue
            except (CommandFailed, WorkerDown, SourceUnavailable) as exc:
                self._skip(link, state, master_ticket, symbol, str(exc), now)
                continue

            if volume <= 0:
                spec = self._specs.get((link.dest_id, dest_symbol), (0, {}))[1]
                self._skip(
                    link, state, master_ticket, symbol,
                    f"the scaled lot is below the {dest_symbol} minimum of {spec.get('volumeMin')}",
                    now,
                )
                continue

            side = link.rules.side_for(master_position["side"])
            sl, tp = link.rules.stops_for(master_position["sl"], master_position["tp"])
            self._emit(
                link, "open",
                f"master opened #{master_ticket} {master_position['side']} {symbol} "
                f"{master_position['volume']}; copying as {side} {dest_symbol} {volume}",
                masterTicket=master_ticket, symbol=dest_symbol, side=side, volume=volume,
            )

            if link.dry_run:
                open_count += 1
                continue

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
            ticket = int(result.get("order") or 0)
            if ticket:
                state.mapping[master_ticket] = ticket
            state.clear_failure(master_ticket)
            state.copied_count += 1
            state.last_action_at = time.time()
            open_count += 1
            self._emit(
                link, "opened",
                f"copied master #{master_ticket} as #{ticket} "
                f"({dest_symbol} {side} {volume} at {result.get('price')})",
                masterTicket=master_ticket, ticket=ticket, price=result.get("price"),
                symbol=dest_symbol, side=side, volume=volume,
                masterSymbol=symbol, masterSide=master_position["side"],
                masterVolume=float(master_position["volume"]),
            )
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
                },
                "cycle": cycles.get(link.id, {}),
            })
        return {
            "running": bool(self._thread and self._thread.is_alive()),
            "pollInterval": self.poll_interval,
            "accounts": self.pool.statuses(),
            "links": out,
        }
