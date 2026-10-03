import { createFileRoute } from "@tanstack/react-router";
import { requireCopierPermission } from "@/server/copier-access";
import { copierJournal, type CopierJournalTrade } from "@/server/copier-client";
import { listCopierLinks } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * The trade journal: every copy made by the caller's own links, with copy
 * latency, slippage and result. ?format=csv downloads it as a spreadsheet.
 */
export const Route = createFileRoute("/api/copier/journal")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const url = new URL(request.url);
          const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
          const linkIds = listCopierLinks(user.id).map((l) => l.id);
          const { trades } = await copierJournal(linkIds, limit);

          if (url.searchParams.get("format") === "csv") {
            return new Response(toCsv(trades), {
              headers: {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="copier-journal-${new Date()
                  .toISOString()
                  .slice(0, 10)}.csv"`,
              },
            });
          }
          return jsonOk({ trades });
        }),
    },
  },
});

const iso = (epochSeconds: number | undefined) =>
  typeof epochSeconds === "number" && epochSeconds > 0
    ? new Date(epochSeconds * 1000).toISOString()
    : "";

const COLUMNS: [string, (t: CopierJournalTrade) => unknown][] = [
  ["Link", (t) => t.linkLabel],
  ["Status", (t) => t.status],
  ["Master ticket", (t) => t.masterTicket],
  ["Master symbol", (t) => t.masterSymbol],
  ["Master lots", (t) => t.masterVolume],
  ["Master price", (t) => t.masterPrice],
  ["Master executed (UTC)", (t) => iso(t.masterExecutedAt)],
  ["Slave ticket", (t) => t.ticket],
  ["Symbol", (t) => t.symbol],
  ["Side", (t) => t.side],
  ["Lots", (t) => t.volume],
  ["Fill price", (t) => t.price],
  ["Filled (UTC)", (t) => iso(t.filledAt ?? t.openedAt)],
  ["Latency ms", (t) => t.latencyMs],
  ["Detection ms", (t) => t.detectionMs],
  ["Execution ms", (t) => t.executionMs],
  ["Slippage pts", (t) => t.slippagePoints],
  ["Closed (UTC)", (t) => iso(t.closedAt)],
  ["Close price", (t) => t.closePrice],
  ["Close reason", (t) => t.closeReason],
  ["Profit", (t) => t.profit],
  ["Swap", (t) => t.swap],
];

function toCsv(trades: CopierJournalTrade[]): string {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = trades.map((t) => COLUMNS.map(([, get]) => cell(get(t))).join(","));
  return [COLUMNS.map(([name]) => name).join(","), ...rows].join("\n") + "\n";
}
