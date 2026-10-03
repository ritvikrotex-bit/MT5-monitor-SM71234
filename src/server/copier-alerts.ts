import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  copierEvents,
  type CopierEvent,
  type CopierRefresh,
  type CopierTestResult,
  type CopierTestStep,
} from "./copier-client";
import { enabledCopierLinkOwners } from "./copier-store";
import { envOptional } from "./env";
import { dataFile } from "./paths";
import { DIVIDER, alertTime, blocks, esc, sendTelegramText, signedMoney } from "./telegram";
import { getUserById } from "./user-store";

/**
 * Forwards copier decisions to each link owner's own Telegram bot.
 *
 * The copier never talks to Telegram itself: the bot tokens are encrypted in
 * the web app's store and belong to individual users, so the web app reads the
 * copier's event feed and sends on their behalf. That keeps every secret in
 * one place and routes each link's alerts to the chat its owner configured.
 *
 * Delivery is followed by sequence number rather than timestamp. A cursor is
 * the only thing that makes "send each event exactly once" survive a restart,
 * a clock change or a slow cycle, and it is persisted so a web app restart
 * does not replay the morning's trades into somebody's phone.
 */

const POLL_MS = 4_000;
/** The copier keeps 500 events; ask for a full page so a burst cannot outrun us. */
const PAGE = 200;

/** Kinds worth a message. The rest are cycle noise. */
const NOTIFY = new Set([
  "opened", // a copy was placed
  "close", // the master closed, so we closed
  "reduce", // the master trimmed, so we trimmed
  "skipped", // a trade could not be copied
  "filtered", // a trade was excluded by the symbol rules
  "error", // an order failed
  "halted", // a guard stopped the link
  "duplicate", // a stray copy was cleaned up
  "manual_close", // user manually closed a slave position; master still open
  "outage", // the master or slave has been unreadable long enough to matter
  "recovered", // ...and is readable again
  "risk", // a risk limit paused copying (once per limit per broker day)
  "trailing_exit", // the slave closed a copy by trailing its profit
  "loss_stop", // the slave closed a copy at the loss-per-trade limit
]);

/**
 * How long the copier service itself may be unreachable before link owners are
 * told. Its events cannot report its own absence, so this side has to.
 */
const SERVICE_DOWN_ALERT_MS = 60_000;

/** How far the feed has been delivered, and which run of the copier that was in. */
type Cursor = { seq: number; boot?: string | undefined };

declare global {
  var __mt5_copier_alerts_started__: boolean | undefined;
  var __mt5_copier_alerts_timer__: ReturnType<typeof setInterval> | undefined;
}

function cursorPath(): string {
  return dataFile("copier-alert-cursor.json");
}

function readCursor(): Cursor {
  const path = cursorPath();
  if (!existsSync(path)) return { seq: -1 }; // -1 means "not started yet"
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      seq: Number.isFinite(parsed.seq) ? Number(parsed.seq) : -1,
      ...(typeof parsed.boot === "string" ? { boot: parsed.boot } : {}),
    };
  } catch {
    return { seq: -1 };
  }
}

function writeCursor(cursor: Cursor): void {
  const path = cursorPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cursor), "utf8");
  } catch (err) {
    console.error("[copier] could not save the alert cursor:", err);
  }
}

/** "BUY 0.10 XAUUSD.c · #4201159", leaving out whatever the event lacks. */
function tradeLine(
  side: string | undefined,
  volume: number | undefined,
  symbol: string | undefined,
  ticket: number | undefined,
  verb = "",
): string {
  const details = [side, volume, symbol ? esc(symbol) : undefined]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const id = ticket ? `<code>#${ticket}</code>` : "";
  // "Closed SELL 0.03 BTCUSD.r · #2572", but just "Closed #4201167".
  if (!details) return [verb, id].filter(Boolean).join(" ");
  return [[verb, details].filter(Boolean).join(" "), id].filter(Boolean).join(" · ");
}

/** Copy latency and slippage for a "Trade Copied" alert, when measured. */
function speedLines(event: CopierEvent): string | null {
  const lines: string[] = [];
  if (typeof event.latencyMs === "number") {
    const parts =
      typeof event.detectionMs === "number" && typeof event.executionMs === "number"
        ? ` (seen ${event.detectionMs} ms + filled ${event.executionMs} ms)`
        : "";
    lines.push(`⚡ <b>Latency:</b> ${event.latencyMs} ms${parts}`);
  } else if (typeof event.executionMs === "number") {
    lines.push(`⚡ <b>Fill time:</b> ${event.executionMs} ms`);
  }
  if (typeof event.slippagePoints === "number") {
    const s = event.slippagePoints;
    const note =
      s > 0 ? "worse than the master" : s < 0 ? "better than the master" : "same as the master";
    lines.push(`📐 <b>Slippage:</b> ${s > 0 ? "+" : ""}${s} pts (${note})`);
  }
  return lines.length ? lines.join("\n") : null;
}

/** "45 s", "4 min 12 s", "2 h 5 min". */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min ${s % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What logging the slave account in again did, for the reader. */
function describeRefresh(refresh: CopierRefresh | undefined, copied: boolean): string | null {
  if (!refresh) return null;
  if (!refresh.ok) {
    return `🔄 <b>Slave account refresh failed</b>\n${esc(refresh.error ?? "unknown error")}`;
  }
  const symbol = refresh.symbol ? esc(refresh.symbol) : null;
  if (copied) {
    return (
      `🔄 <b>Slave account refreshed</b>\n` +
      (symbol
        ? `${symbol} was not visible until the slave logged in again; it is now.`
        : `The slave logged in again and picked up the symbol.`)
    );
  }
  const counts =
    refresh.symbolsBefore !== undefined && refresh.symbolsAfter !== undefined
      ? ` (${refresh.symbolsBefore} → ${refresh.symbolsAfter} symbols)`
      : "";
  return (
    `🔄 <b>Slave account refreshed</b>\n` +
    (symbol
      ? `Logged in again to re-check ${symbol}: still not available.`
      : `Logged in again to reload its symbols${counts}: still no match.`)
  );
}

function hintFor(event: CopierEvent): string | null {
  const reason = event.reason ?? event.message;
  if (!/not tradable|no symbol matching|only accepts/i.test(reason)) return null;
  return (
    `💡 Ask the broker to enable it on the slave account, ` +
    `or block ${esc(event.masterSymbol ?? "this symbol")} in the link's symbol rules.`
  );
}

/**
 * Both sides of the trade in one structured message.
 *
 * The master block is what was seen; the slave block is what was done about
 * it. Showing only one leaves the reader unable to tell a copy from a miss.
 */
export function formatCopierEvent(event: CopierEvent): string {
  const master = esc(event.masterLabel ?? "master");
  const dest = esc(event.destLabel ?? "destination");
  const head = (icon: string, title: string) =>
    `${icon} <b>${esc(title)}</b>\n<i>${esc(event.linkLabel)}</i>\n${DIVIDER}`;
  const masterBlock = (line: string) => `📡 <b>Master</b> · ${master}\n${line}`;
  const slaveBlock = (line: string) => `🎯 <b>Slave</b> · ${dest}\n${line}`;
  const dry = event.dryRun ? `🧪 <i>Dry run — no order was sent.</i>` : null;
  const footer = `🕒 ${esc(alertTime(new Date(event.at * 1000)))}`;

  switch (event.kind) {
    case "opened":
      return blocks(
        head("🟢", "Trade Copied"),
        masterBlock(
          tradeLine(event.masterSide, event.masterVolume, event.masterSymbol, event.masterTicket),
        ),
        slaveBlock(
          tradeLine(event.side, event.volume, event.symbol, event.ticket) +
            (event.price ? `\nFilled at <code>${event.price}</code>` : ""),
        ),
        speedLines(event),
        describeRefresh(event.refresh, true),
        dry,
        footer,
      );

    case "close": {
      const profit = typeof event.profit === "number" ? event.profit : null;
      const won = profit !== null && profit > 0;
      const result =
        profit === null
          ? null
          : profit > 0
            ? `💰 <b>P/L: ${signedMoney(profit, "")}</b>`
            : profit < 0
              ? `🔻 <b>P/L: ${signedMoney(profit, "")}</b>`
              : `⚖️ <b>P/L: ${signedMoney(profit, "")}</b>`;
      return blocks(
        head(won ? "🎉" : "🔴", won ? "Copy Closed in Profit" : "Copy Closed"),
        masterBlock(tradeLine(undefined, undefined, undefined, event.masterTicket, "Closed")),
        slaveBlock(tradeLine(event.side, event.volume, event.symbol, event.ticket, "Closed")),
        result,
        dry,
        footer,
      );
    }

    case "reduce":
      if (event.fromVolume === undefined) {
        return blocks(head("🟡", "Copy Reduced"), esc(event.message), dry, footer);
      }
      return blocks(
        head("🟡", "Partial Close Copied"),
        masterBlock(
          `Reduced ${event.masterFromVolume} → ${event.masterVolume} lots · ` +
            `<code>#${event.masterTicket}</code>`,
        ),
        slaveBlock(
          `Reduced ${event.fromVolume} → ${event.volume} lots ${esc(event.symbol ?? "")} · ` +
            `<code>#${event.ticket}</code>`,
        ),
        dry,
        footer,
      );

    case "risk":
      return blocks(
        head("🛑", "Copying Paused"),
        `🚦 <b>${esc(String(event.limit ?? "Risk limit"))}</b>\n${esc(event.detail ?? event.message)}`,
        event.masterTicket
          ? masterBlock(
              `${tradeLine(event.masterSide, event.masterVolume, event.masterSymbol, event.masterTicket)} — not copied`,
            )
          : null,
        `⏯️ New trades are not copied; open copies are still managed.\n` +
          `Copying resumes ${esc(event.resumes ?? "once the limit clears")}.`,
        dry,
        footer,
      );

    case "trailing_exit": {
      const won = (event.exitProfit ?? 0) > 0;
      return blocks(
        head(won ? "🎉" : "💰", "Trailing Exit"),
        slaveBlock(tradeLine(event.side, event.volume, event.symbol, event.ticket, "Closed")),
        [
          `<b>Peak profit:</b> ${signedMoney(event.peak ?? 0, "")}`,
          `<b>Allowed retracement:</b> ${(event.retracement ?? 0).toFixed(2)} ` +
            `(${event.drawdownPct ?? 0}%)`,
          `<b>Exit floor:</b> ${signedMoney(event.floor ?? 0, "")}`,
        ].join("\n"),
        `${won ? "💰" : "🔻"} <b>Exit profit: ${signedMoney(event.exitProfit ?? 0, "")}</b>`,
        `The master trade <code>#${event.masterTicket}</code> may still be open; it is not copied again.`,
        dry,
        footer,
      );
    }

    case "loss_stop":
      return blocks(
        head("🔻", "Loss Stop: Copy Closed"),
        slaveBlock(tradeLine(event.side, event.volume, event.symbol, event.ticket, "Closed")),
        `<b>Loss:</b> ${signedMoney(event.loss ?? 0, "")}\n` +
          `<b>Limit per trade:</b> -${Number(event.limit ?? 0).toFixed(2)}`,
        `The master trade <code>#${event.masterTicket}</code> may still be open; it is not copied again.`,
        dry,
        footer,
      );

    case "skipped":
    case "filtered":
      return blocks(
        head("⚪", "Trade Not Copied"),
        masterBlock(
          tradeLine(event.masterSide, event.masterVolume, event.masterSymbol, event.masterTicket),
        ),
        `❗ <b>Reason</b>\n${esc(event.reason ?? event.message)}`,
        describeRefresh(event.refresh, false),
        hintFor(event),
        dry,
        footer,
      );

    case "duplicate":
      return blocks(head("🟠", "Duplicate Copy Removed"), esc(event.message), footer);

    case "manual_close":
      return blocks(
        head("🙋", "Slave Copy Closed Early"),
        masterBlock(tradeLine(undefined, undefined, undefined, event.masterTicket, "Still open")),
        slaveBlock(
          tradeLine(undefined, undefined, undefined, event.ticket, "Closed") +
            `\nby hand, or by its own stop loss / take profit`,
        ),
        `The copier will not re-open it while the master trade is still active.`,
        footer,
      );

    case "halted":
      return blocks(
        head("⛔", "Copy Link Halted"),
        esc(event.message),
        `It stays stopped until you arm it again.`,
        footer,
      );

    case "error":
      return blocks(head("⚠️", "Copier Error"), esc(event.message), footer);

    case "outage": {
      const isMaster = event.account === "master";
      const since = typeof event.since === "number" ? alertTime(new Date(event.since * 1000)) : "";
      const open = event.openCopies ?? 0;
      return blocks(
        head("⚠️", isMaster ? "Copier Can't Read the Master" : "Copier Can't Reach the Slave"),
        (isMaster ? masterBlock : slaveBlock)(`Unreachable since ${esc(since)}`),
        `❗ <b>Reason</b>\n${esc(event.reason ?? event.message)}`,
        `⏸️ Nothing is copied or closed until it is back.` +
          (open > 0
            ? `\n${open} cop${open === 1 ? "y is" : "ies are"} open on the slave and not being managed.`
            : ""),
        footer,
      );
    }

    case "recovered": {
      const isMaster = event.account === "master";
      return blocks(
        head("✅", "Copier Reconnected"),
        (isMaster ? masterBlock : slaveBlock)(
          `Readable again after ${esc(formatDuration(event.downSeconds ?? 0))}`,
        ),
        `🔄 Catching up now: trades opened or closed meanwhile are being matched.`,
        footer,
      );
    }

    default:
      return blocks(head("ℹ️", "Copier"), esc(event.message), footer);
  }
}

const STEP_ICON: Record<CopierTestStep["status"], string> = {
  pass: "✅",
  warn: "⚠️",
  fail: "❌",
};

/** The result of a test run, as sent to the link owner's Telegram. */
export function formatCopierTestResult(result: CopierTestResult): string {
  const title = result.ok ? "Test Run Passed" : "Test Run Found Problems";
  const steps = result.steps
    .map((step) => `${STEP_ICON[step.status]} <b>${esc(step.title)}</b>\n${esc(step.detail)}`)
    .join("\n");
  return blocks(
    `🧪 <b>${title}</b>\n<i>${esc(result.linkLabel)}</i>\n${DIVIDER}`,
    steps,
    `<i>This was a test: no order was placed.</i>`,
    `🕒 ${esc(alertTime(new Date(result.at * 1000)))}`,
  );
}

async function deliver(event: CopierEvent): Promise<void> {
  if (!event.ownerId) return;
  // Re-read the owner: a revoked Telegram permission must take effect at once.
  const owner = getUserById(event.ownerId);
  if (!owner || owner.permissions?.canUseTelegram === false) return;
  const result = await sendTelegramText(event.ownerId, formatCopierEvent(event), { html: true });
  if (result.status === "failed") {
    console.error(`[copier] Telegram delivery failed: ${result.error ?? "unknown"}`);
  }
}

/** The copier service stopped answering, or came back: tell owners of running links. */
export function formatServiceAlert(state: "down" | "up", links: string[], downMs: number): string {
  const footer = `🕒 ${esc(alertTime(new Date()))}`;
  const list = links.map((label) => `• ${esc(label)}`).join("\n");
  if (state === "down") {
    return blocks(
      `🛑 <b>Trade Copier Offline</b>\n${DIVIDER}`,
      `The copier service has not answered for ${esc(formatDuration(downMs / 1000))}.`,
      `⏸️ <b>Not copying</b>\n${list}`,
      `Open copies stay on the slave but are not managed until it is back.`,
      footer,
    );
  }
  return blocks(
    `✅ <b>Trade Copier Back Online</b>\n${DIVIDER}`,
    `The copier service is answering again after ${esc(formatDuration(downMs / 1000))}.`,
    `🔄 <b>Catching up</b>\n${list}`,
    footer,
  );
}

async function announceService(state: "down" | "up", downMs: number): Promise<void> {
  for (const [ownerId, links] of enabledCopierLinkOwners()) {
    const owner = getUserById(ownerId);
    if (!owner || owner.permissions?.canUseTelegram === false) continue;
    const result = await sendTelegramText(ownerId, formatServiceAlert(state, links, downMs), {
      html: true,
    });
    if (result.status === "failed") {
      console.error(`[copier] Telegram delivery failed: ${result.error ?? "unknown"}`);
    }
  }
}

export function startCopierAlerts(): void {
  if (globalThis.__mt5_copier_alerts_started__) return;
  if (!envOptional("MT5_COPIER_SECRET", envOptional("COPIER_SECRET"))) return;
  globalThis.__mt5_copier_alerts_started__ = true;

  const saved = readCursor();
  let cursor = saved.seq;
  let boot = saved.boot;
  let running = false;
  // When the copier service stopped answering, and whether owners were told.
  let downSince: number | null = null;
  let downAlerted = false;

  const tick = async () => {
    if (running) return; // a slow Telegram round trip must not stack up cycles
    running = true;
    try {
      if (cursor < 0) {
        // First ever run: start from the present rather than replaying the
        // whole buffer, which would be a wall of history nobody asked for.
        const first = await copierEvents(1);
        cursor = first.cursor ?? 0;
        boot = first.boot;
        writeCursor({ seq: cursor, boot });
        return;
      }

      let page = await copierEvents(PAGE, cursor);
      const restarted = page.boot && boot ? page.boot !== boot : (page.cursor ?? cursor) < cursor;
      if (restarted) {
        // The copier restarted and its counter began again at zero. Everything
        // it has said since is new, so read from the start of its feed rather
        // than skipping ahead to its new count — that used to drop the alerts
        // for whatever it did straight after the restart.
        cursor = 0;
        page = await copierEvents(PAGE, 0);
      }
      boot = page.boot ?? boot;

      if (downSince !== null) {
        if (downAlerted) await announceService("up", Date.now() - downSince);
        downSince = null;
        downAlerted = false;
      }

      for (const event of page.events) {
        if (NOTIFY.has(event.kind)) {
          try {
            await deliver(event);
          } catch (err) {
            // One bad message must not block the rest, but the cursor still
            // moves: retrying forever would pin the feed on a single failure.
            console.error("[copier] could not send an alert:", err);
          }
        }
        cursor = Math.max(cursor, event.seq ?? cursor);
      }
      writeCursor({ seq: cursor, boot });
    } catch {
      // The copier is not answering. Its own events cannot report that, so
      // after a grace period the owners of running links are told directly.
      downSince ??= Date.now();
      if (!downAlerted && Date.now() - downSince >= SERVICE_DOWN_ALERT_MS) {
        downAlerted = true;
        await announceService("down", Date.now() - downSince).catch(() => {});
      }
    } finally {
      running = false;
    }
  };

  if (globalThis.__mt5_copier_alerts_timer__) {
    clearInterval(globalThis.__mt5_copier_alerts_timer__);
  }
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
  globalThis.__mt5_copier_alerts_timer__ = timer;
  console.log("[copier] Telegram alerts enabled");
}
