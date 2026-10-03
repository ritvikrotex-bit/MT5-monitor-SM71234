import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "./crypto";
import { listAllMonitored } from "./monitor-store";
import type { StoredAlert } from "./notification-store";
import { dataFile } from "./paths";

// Every user has their OWN Telegram bot token + chat id. Alerts for a user's monitored clients are
// delivered only to that user's chat. There is deliberately no shared/global fallback: it would send
// one user's trade data to another user's group.
//
// data/telegram.json: { "users": { "<userId>": { "botTokenEnc": "...", "chatId": "...", "updatedAt": "..." } } }
// The bot token is encrypted at rest with the same key as the broker passwords (encryption.key).
type Entry = {
  botTokenEnc?: string;
  botToken?: string; // legacy plaintext, encrypted on first use
  chatId: string;
  updatedAt: string;
};
type Store = { users: Record<string, Entry> };

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_RE = /^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export const isValidBotToken = (value: string): boolean => TOKEN_RE.test(value.trim());
export const isValidChatId = (value: string): boolean => CHAT_RE.test(value.trim());

// Overridable so tests can run against a local fake instead of the real Telegram API.
const apiBase = (): string =>
  (process.env["TELEGRAM_API_BASE"] || "https://api.telegram.org").replace(/\/$/, "");

const filePath = (): string => dataFile("telegram.json");

let storePromise: Promise<Store> | null = null;

function writeStore(store: Store): void {
  mkdirSync(dirname(filePath()), { recursive: true });
  writeFileSync(filePath(), JSON.stringify(store, null, 2) + "\n", "utf-8");
}

async function readStore(): Promise<Store> {
  const file = filePath();
  if (!existsSync(file)) return { users: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
  } catch (error) {
    console.error("[Telegram] Could not read data/telegram.json:", error);
    return { users: {} };
  }
  const data = (parsed ?? {}) as {
    users?: Record<string, Entry>;
    botToken?: string;
    chatId?: string;
  };
  if (data.users && typeof data.users === "object") return { users: data.users };

  // Legacy single global bot ({ botToken, chatId }) from before per-user Telegram. Give it to the
  // one user who has monitored clients; if that is ambiguous, keep the file untouched and say so.
  if (data.botToken && data.chatId) {
    const owners = [...new Set(listAllMonitored().map((m) => m.userId))];
    if (owners.length === 1 && owners[0]) {
      const store: Store = {
        users: {
          [owners[0]]: {
            botTokenEnc: await encryptSecret(data.botToken),
            chatId: data.chatId,
            updatedAt: new Date().toISOString(),
          },
        },
      };
      writeStore(store);
      console.log(`[Telegram] Migrated the old shared Telegram bot to user ${owners[0]}.`);
      return store;
    }
    console.warn(
      "[Telegram] data/telegram.json is in the old shared format and cannot be assigned to a single user. " +
        "Each user must now set their own bot under Settings > Telegram.",
    );
  }
  return { users: {} };
}

function loadStore(): Promise<Store> {
  storePromise ??= readStore();
  return storePromise;
}

export type TelegramSummary = { configured: boolean; chatId: string | null };

/** Whether this user has Telegram set up, plus their own chat id (never the token). */
export async function telegramSummary(userId: string): Promise<TelegramSummary> {
  const entry = (await loadStore()).users[userId];
  return entry ? { configured: true, chatId: entry.chatId } : { configured: false, chatId: null };
}

async function getTelegramConfig(
  userId: string,
): Promise<{ botToken: string; chatId: string } | null> {
  const entry = (await loadStore()).users[userId];
  if (!entry) return null;
  try {
    if (entry.botTokenEnc)
      return { botToken: await decryptSecret(entry.botTokenEnc), chatId: entry.chatId };
    if (entry.botToken) return { botToken: entry.botToken, chatId: entry.chatId };
  } catch (error) {
    console.error(`[Telegram] Could not decrypt the bot token of user ${userId}:`, error);
  }
  return null;
}

export async function saveTelegramConfig(
  userId: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const store = await loadStore();
  store.users[userId] = {
    botTokenEnc: await encryptSecret(botToken.trim()),
    chatId: chatId.trim(),
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

export async function deleteTelegramConfig(userId: string): Promise<boolean> {
  const store = await loadStore();
  if (!store.users[userId]) return false;
  delete store.users[userId];
  writeStore(store);
  return true;
}

// -- message formatting -----------------------------------------------------
//
// Alerts are sent in Telegram's HTML mode so headings can be bold and tickets
// monospace. Anything that came from outside (client names, labels, symbols)
// goes through esc(), and a message Telegram still refuses to parse is resent
// as plain text, so a formatting slip can never cost the alert itself.

/** Telegram's HTML mode needs only these three escaped. */
export const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const htmlToPlain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Short enough not to wrap on a phone. */
export const DIVIDER = "━━━━━━━━━━━━━━━━";

export function alertTime(at: Date): string {
  return at.toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" });
}

export const signedMoney = (value: number, symbol = "$"): string =>
  `${value >= 0 ? "+" : "-"}${symbol}${Math.abs(value).toFixed(2)}`;

/** Separate blocks with one blank line, skipping empty ones. */
export const blocks = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join("\n\n");

function formatPrice(val: number | null | undefined): string {
  if (val == null || val === 0) return "—";
  return String(val);
}

const field = (label: string, value: string) => `<b>${label}:</b> ${value}`;
const change = (from: number | null | undefined, to: number | null | undefined) =>
  `${formatPrice(from)} → ${formatPrice(to)}`;

/** Green for profit, red for loss — and a party popper for a win. */
function closeOutcome(profit: number): { icon: string; label: string; line: string } {
  if (profit > 0)
    return { icon: "🎉", label: "in Profit", line: `💰 <b>Profit: ${signedMoney(profit)}</b>` };
  if (profit < 0) return { icon: "🔴", label: "", line: `🔻 <b>Loss: ${signedMoney(profit)}</b>` };
  return { icon: "🔴", label: "", line: `⚖️ <b>P/L: ${signedMoney(profit)}</b>` };
}

export function formatAlertMessage(alert: StoredAlert): string {
  const p = alert.position;
  const head = (icon: string, title: string) => `${icon} <b>${esc(title)}</b>\n${DIVIDER}`;
  const client = [
    field("Client", esc(alert.clientName)),
    field("Login", `<code>${esc(alert.clientLogin)}</code>`),
    ...(alert.brokerName ? [field("Broker", esc(alert.brokerName))] : []),
  ].join("\n");
  const trade = (...rows: string[]) =>
    [
      `📊 <b>${esc(p.symbol)} · ${p.direction} ${p.volume.toFixed(2)} lots</b>`,
      field("Position", `<code>#${esc(p.positionId)}</code>`),
      ...rows,
    ].join("\n");
  const footer = `🕒 ${esc(alertTime(new Date(alert.createdAt)))}`;

  switch (alert.type) {
    case "new_position":
      return blocks(
        head("🟢", "New Position"),
        client,
        trade(
          field("Open price", formatPrice(p.openPrice)),
          field("Stop loss", formatPrice(p.sl)),
          field("Take profit", formatPrice(p.tp)),
        ),
        footer,
      );

    case "position_closed": {
      const outcome = closeOutcome(p.profit);
      return blocks(
        head(outcome.icon, `Position Closed ${outcome.label}`.trim()),
        client,
        trade(
          field("Open price", formatPrice(p.openPrice)),
          ...(p.currentPrice != null ? [field("Close price", formatPrice(p.currentPrice))] : []),
        ),
        outcome.line,
        footer,
      );
    }

    case "sl_modified":
      return blocks(
        head("🟡", "Stop Loss Modified"),
        client,
        trade(field("Stop loss", change(alert.from, alert.to))),
        footer,
      );

    case "tp_modified":
      return blocks(
        head("🟡", "Take Profit Modified"),
        client,
        trade(field("Take profit", change(alert.from, alert.to))),
        footer,
      );

    default: {
      // position_modified: a volume change, or several fields at once. Older
      // records only carry from/to, which always meant volume.
      const changes =
        alert.changes ??
        (alert.from !== undefined && alert.to !== undefined
          ? { volume: { from: alert.from ?? null, to: alert.to ?? null } }
          : {});
      const rows = [
        ...(changes.volume
          ? [field("Volume", `${change(changes.volume.from, changes.volume.to)} lots`)]
          : []),
        ...(changes.sl ? [field("Stop loss", change(changes.sl.from, changes.sl.to))] : []),
        ...(changes.tp ? [field("Take profit", change(changes.tp.from, changes.tp.to))] : []),
      ];
      const title =
        changes.sl && changes.tp && !changes.volume
          ? "Stop Loss & Take Profit Modified"
          : "Position Modified";
      return blocks(
        head("🟡", title),
        client,
        trade(
          ...rows,
          field("Current price", formatPrice(p.currentPrice)),
          field("P/L", signedMoney(p.profit)),
        ),
        footer,
      );
    }
  }
}

async function postMessage(
  botToken: string,
  chatId: string,
  text: string,
  html = false,
): Promise<{ ok: boolean; error?: string }> {
  const first = await sendOnce(botToken, chatId, text, html);
  if (first.ok || !html || !/pars|entit/i.test(first.error ?? "")) return first;
  console.warn("[Telegram] Formatted message was rejected; resending as plain text.");
  return sendOnce(botToken, chatId, htmlToPlain(text), false);
}

async function sendOnce(
  botToken: string,
  chatId: string,
  text: string,
  html: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${apiBase()}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(html ? { parse_mode: "HTML" } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (response.ok && result?.ok) return { ok: true };

    const errMsg = result?.description || `HTTP ${response.status} ${response.statusText}`;
    console.error("[Telegram] API error:", errMsg);
    return { ok: false, error: errMsg };
  } catch (err) {
    // Never log err.cause / URLs: they contain the bot token.
    const errMsg = err instanceof Error ? err.message : "Network error";
    console.error("[Telegram] Network failure while sending message:", errMsg);
    return { ok: false, error: errMsg };
  }
}

const TEST_TEXT =
  `✅ MT5 Monitor Telegram test successful.\n\n` +
  `Your Telegram notification channel is configured correctly.\n` +
  `Live trade activity for your monitored clients will be delivered here.`;

/** Sends the test message with candidate credentials, before they are saved. */
export function verifyTelegramCredentials(botToken: string, chatId: string) {
  return postMessage(botToken.trim(), chatId.trim(), TEST_TEXT);
}

/** Sends the test message using the user's saved credentials. */
export async function sendTelegramTestMessage(
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getTelegramConfig(userId);
  if (!cfg) return { ok: false, error: "Telegram is not configured for your account." };
  return postMessage(cfg.botToken, cfg.chatId, TEST_TEXT);
}

/** Delivers an alert to the chat of the user who owns the monitored client, and only to that chat. */
/**
 * Send one message to a user's own Telegram bot.
 *
 * Used by anything that is not a monitor alert — the trade copier, for
 * instance — so it goes to the same chat the user configured for themselves
 * and nowhere else.
 */
export async function sendTelegramText(
  userId: string,
  text: string,
  options: { html?: boolean } = {},
): Promise<{ status: "sent" | "not_configured" | "failed"; error?: string }> {
  const cfg = await getTelegramConfig(userId);
  if (!cfg) return { status: "not_configured" };
  const res = await postMessage(cfg.botToken, cfg.chatId, text, options.html ?? false);
  return { status: res.ok ? "sent" : "failed", ...(res.error ? { error: res.error } : {}) };
}

export async function sendTelegramAlert(
  alert: StoredAlert,
): Promise<{ status: "sent" | "not_configured" | "failed"; error?: string }> {
  const cfg = await getTelegramConfig(alert.userId);
  if (!cfg) return { status: "not_configured" };
  const res = await postMessage(cfg.botToken, cfg.chatId, formatAlertMessage(alert), true);
  return {
    status: res.ok ? "sent" : "failed",
    ...(res.error ? { error: res.error } : {}),
  };
}
