"""The trade journal: one row for every copy opened and every copy closed.

Each copy's open row records when the master executed, when the copier saw
it, sent the order and got the fill (and so the copy latency), the prices on
both sides (and so the slippage). Its close row adds why and at what price it
closed, and what it made. The rows are appended to a JSON-lines file in the
copier's state folder, so the record survives restarts and needs no database.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger("copier.journal")

# Past this size the file is rotated to .1 (the previous .1 is dropped), which
# keeps months of normal trading while bounding the disk it can take.
MAX_BYTES = 20 * 1024 * 1024


class Journal:
    def __init__(self, path: Path, *, max_bytes: int = MAX_BYTES) -> None:
        self.path = Path(path)
        self.max_bytes = max_bytes
        self._lock = threading.Lock()

    def append(self, row: dict[str, Any]) -> None:
        line = json.dumps(row, default=str) + "\n"
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if self.path.is_file() and self.path.stat().st_size >= self.max_bytes:
                    self.path.replace(self.path.with_suffix(self.path.suffix + ".1"))
            except OSError as exc:
                log.warning("could not rotate the trade journal: %s", exc)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line)

    def rows(self) -> list[dict[str, Any]]:
        """Every row, oldest first, including the rotated file."""
        out: list[dict[str, Any]] = []
        with self._lock:
            for path in (self.path.with_suffix(self.path.suffix + ".1"), self.path):
                if not path.is_file():
                    continue
                for line in path.read_text(encoding="utf-8").splitlines():
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue  # a torn last line after a crash
        return out

    def trades(
        self, *, link_ids: set[str] | None = None, since: float = 0.0, limit: int = 500
    ) -> list[dict[str, Any]]:
        """Open and close rows paired into one record per copy, newest first."""
        trades: dict[tuple[str, int], dict[str, Any]] = {}
        for row in self.rows():
            if link_ids is not None and row.get("linkId") not in link_ids:
                continue
            key = (str(row.get("linkId")), int(row.get("masterTicket") or 0))
            trade = trades.setdefault(key, {"status": "open"})
            if row.get("kind") == "open":
                trade.update({k: v for k, v in row.items() if k not in ("kind", "at")})
                trade["openedAt"] = row.get("filledAt") or row.get("at")
            elif row.get("kind") == "close":
                trade.setdefault("linkId", row.get("linkId"))
                trade.setdefault("linkLabel", row.get("linkLabel"))
                trade.setdefault("masterTicket", row.get("masterTicket"))
                for field in ("symbol", "side", "ticket", "price", "masterSymbol", "masterPrice",
                              "latencyMs", "slippagePoints"):
                    if trade.get(field) is None and row.get(field) is not None:
                        trade[field] = row[field]
                trade.update({
                    "status": "closed",
                    "closedAt": row.get("closedAt") or row.get("at"),
                    "closePrice": row.get("closePrice"),
                    "closeReason": row.get("closeReason"),
                    "profit": row.get("profit"),
                    "swap": row.get("swap"),
                    "closedVolume": row.get("volume"),
                })
        out = [t for t in trades.values() if (t.get("openedAt") or t.get("closedAt") or 0) >= since]
        out.sort(key=lambda t: t.get("openedAt") or t.get("closedAt") or 0, reverse=True)
        return out[: max(1, limit)]
