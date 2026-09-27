import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { copierEvents, type CopierEvent } from "./copier-client";
import { envOptional } from "./env";
import { dataFile } from "./paths";
import { sendTelegramText } from "./telegram";
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
]);

type Cursor = { seq: number };

declare global {
  var __mt5_copier_alerts_started__: boolean | undefined;
  var __mt5_copier_alerts_timer__: ReturnType<typeof setInterval> | undefined;
}

function cursorPath(): string {
  return dataFile("copier-alert-cursor.json");
}

function readCursor(): number {
  const path = cursorPath();
  if (!existsSync(path)) return -1; // -1 means "not started yet"
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return Number.isFinite(parsed.seq) ? Number(parsed.seq) : -1;
  } catch {
    return -1;
  }
}

function writeCursor(seq: number): void {
  const path = cursorPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ seq }), "utf8");
  } catch (err) {
    console.error("[copier] could not save the alert cursor:", err);
  }
}

const money = (value: unknown) =>
  typeof value === "number" ? value.toFixed(2) : String(value ?? "");

/**
 * Both sides of the trade in one message.
 *
 * The master line is what was seen; the slave line is what was done about it.
 * Showing only one leaves the reader unable to tell a copy from a miss.
 */
export function formatCopierEvent(event: CopierEvent): string {
  const master = event.masterLabel ?? "master";
  const dest = event.destLabel ?? "destination";
  const dry = event.dryRun ? "\n\n(dry run — no order was sent)" : "";
  const head = (icon: string, title: string) => `${icon} ${title}\n${event.linkLabel}`;

  switch (event.kind) {
    case "opened":
      return (
        `${head("🟢", "Trade copied")}\n\n` +
        `Master · ${master}\n` +
        `  ${event.masterSide ?? ""} ${event.masterVolume ?? ""} ${event.masterSymbol ?? ""}`.trimEnd() +
        `  #${event.masterTicket}\n\n` +
        `Slave · ${dest}\n` +
        `  ${event.side ?? ""} ${event.volume ?? ""} ${event.symbol ?? ""}`.trimEnd() +
        `  #${event.ticket}` +
        (event.price ? `\n  Filled at ${event.price}` : "") +
        dry
      );
    case "close":
      return (
        `${head("🔴", "Copy closed")}\n\n` +
        `Master · ${master}\n  Closed #${event.masterTicket}\n\n` +
        `Slave · ${dest}\n` +
        `  Closed ${event.volume ?? ""} ${event.symbol ?? ""}`.trimEnd() +
        `  #${event.ticket}` +
        (typeof event.profit === "number" ? `\n  P/L ${money(event.profit)}` : "") +
        dry
      );
    case "reduce":
      return `${head("🟡", "Copy reduced")}\n\n${event.message}${dry}`;
    case "skipped":
    case "filtered":
      return `${head("⚪", "Trade not copied")}\n\n${event.message}${dry}`;
    case "duplicate":
      return `${head("🟠", "Duplicate copy removed")}\n\n${event.message}`;
    case "manual_close":
      return (
        `${head("🙋", "Slave position manually closed")}\n\n` +
        `Master · ${master}  #${event.masterTicket}\n` +
        `Slave · ${dest}  #${event.ticket} was manually closed.\n\n` +
        `The copier will not re-open it while the master trade is still active.`
      );
    case "halted":
      return (
        `${head("⛔", "Copy link halted")}\n\n${event.message}\n\n` +
        `It stays stopped until you arm it.`
      );
    case "error":
      return `${head("⚠️", "Copier error")}\n\n${event.message}`;
    default:
      return `${head("ℹ️", "Copier")}\n\n${event.message}`;
  }
}

async function deliver(event: CopierEvent): Promise<void> {
  if (!event.ownerId) return;
  // Re-read the owner: a revoked Telegram permission must take effect at once.
  const owner = getUserById(event.ownerId);
  if (!owner || owner.permissions?.canUseTelegram === false) return;
  const result = await sendTelegramText(event.ownerId, formatCopierEvent(event));
  if (result.status === "failed") {
    console.error(`[copier] Telegram delivery failed: ${result.error ?? "unknown"}`);
  }
}

export function startCopierAlerts(): void {
  if (globalThis.__mt5_copier_alerts_started__) return;
  if (!envOptional("MT5_COPIER_SECRET", envOptional("COPIER_SECRET"))) return;
  globalThis.__mt5_copier_alerts_started__ = true;

  let cursor = readCursor();
  let running = false;

  const tick = async () => {
    if (running) return; // a slow Telegram round trip must not stack up cycles
    running = true;
    try {
      if (cursor < 0) {
        // First ever run: start from the present rather than replaying the
        // whole buffer, which would be a wall of history nobody asked for.
        const { cursor: latest } = await copierEvents(1);
        cursor = latest ?? 0;
        writeCursor(cursor);
        return;
      }

      const { events, cursor: latest } = await copierEvents(PAGE, cursor);
      for (const event of events) {
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
      if (events.length === 0 && typeof latest === "number" && latest < cursor) {
        // The copier restarted and its counter went back to zero; follow it
        // rather than waiting for it to climb past a stale cursor.
        cursor = latest;
      }
      writeCursor(cursor);
    } catch {
      // The copier being down is already reported elsewhere; alerts resume on
      // their own once it answers again.
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
