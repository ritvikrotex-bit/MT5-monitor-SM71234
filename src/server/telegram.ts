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

function formatPrice(val: number | null | undefined): string {
  if (val == null) return "—";
  return String(val);
}

export function formatAlertMessage(alert: StoredAlert): string {
  const p = alert.position;
  const brokerLine = alert.brokerName ? `Broker: ${alert.brokerName}\n` : "";
  const time = new Date(alert.createdAt).toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  });

  if (alert.type === "new_position") {
    return (
      `🟢 New Position\n\n` +
      `Client: ${alert.clientName}\n` +
      `Login: ${alert.clientLogin}\n` +
      brokerLine +
      `\n` +
      `Position: #${p.positionId}\n` +
      `Symbol: ${p.symbol}\n` +
      `Direction: ${p.direction}\n` +
      `Volume: ${p.volume.toFixed(2)} lots\n` +
      `Open Price: ${formatPrice(p.openPrice)}\n` +
      `SL: ${formatPrice(p.sl)}\n` +
      `TP: ${formatPrice(p.tp)}\n\n` +
      `Time: ${time}`
    );
  }

  if (alert.type === "position_closed") {
    const profitSign =
      p.profit >= 0 ? `+$${p.profit.toFixed(2)}` : `-$${Math.abs(p.profit).toFixed(2)}`;
    return (
      `🔴 Position Closed\n\n` +
      `Client: ${alert.clientName}\n` +
      `Login: ${alert.clientLogin}\n` +
      brokerLine +
      `\n` +
      `Position: #${p.positionId}\n` +
      `Symbol: ${p.symbol}\n` +
      `Direction: ${p.direction}\n` +
      `Volume: ${p.volume.toFixed(2)} lots\n` +
      `Open Price: ${formatPrice(p.openPrice)}\n` +
      (p.currentPrice != null ? `Close Price: ${formatPrice(p.currentPrice)}\n` : "") +
      `Profit: ${profitSign}\n\n` +
      `Time: ${time}`
    );
  }

  if (alert.type === "sl_modified") {
    return (
      `🟡 Stop Loss Modified\n\n` +
      `Client: ${alert.clientName}\n` +
      `Login: ${alert.clientLogin}\n` +
      brokerLine +
      `\n` +
      `Position: #${p.positionId}\n` +
      `Symbol: ${p.symbol}\n` +
      `Direction: ${p.direction}\n` +
      `SL: ${formatPrice(alert.from)} → ${formatPrice(alert.to)}\n\n` +
      `Time: ${time}`
    );
  }

  if (alert.type === "tp_modified") {
    return (
      `🟡 Take Profit Modified\n\n` +
      `Client: ${alert.clientName}\n` +
      `Login: ${alert.clientLogin}\n` +
      brokerLine +
      `\n` +
      `Position: #${p.positionId}\n` +
      `Symbol: ${p.symbol}\n` +
      `Direction: ${p.direction}\n` +
      `TP: ${formatPrice(alert.from)} → ${formatPrice(alert.to)}\n\n` +
      `Time: ${time}`
    );
  }

  // position_modified (volume or general modification)
  const changeDetail =
    alert.from !== undefined && alert.to !== undefined
      ? `Volume: ${formatPrice(alert.from)} → ${formatPrice(alert.to)} lots\n`
      : "";
  return (
    `🟡 Position Modified\n\n` +
    `Client: ${alert.clientName}\n` +
    `Login: ${alert.clientLogin}\n` +
    brokerLine +
    `\n` +
    `Position: #${p.positionId}\n` +
    `Symbol: ${p.symbol}\n` +
    `Direction: ${p.direction}\n` +
    changeDetail +
    `Current Price: ${formatPrice(p.currentPrice)}\n` +
    `P/L: $${p.profit.toFixed(2)}\n\n` +
    `Time: ${time}`
  );
}

async function postMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${apiBase()}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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
): Promise<{ status: "sent" | "not_configured" | "failed"; error?: string }> {
  const cfg = await getTelegramConfig(userId);
  if (!cfg) return { status: "not_configured" };
  const res = await postMessage(cfg.botToken, cfg.chatId, text);
  return { status: res.ok ? "sent" : "failed", ...(res.error ? { error: res.error } : {}) };
}

export async function sendTelegramAlert(
  alert: StoredAlert,
): Promise<{ status: "sent" | "not_configured" | "failed"; error?: string }> {
  const cfg = await getTelegramConfig(alert.userId);
  if (!cfg) return { status: "not_configured" };
  const res = await postMessage(cfg.botToken, cfg.chatId, formatAlertMessage(alert));
  return {
    status: res.ok ? "sent" : "failed",
    ...(res.error ? { error: res.error } : {}),
  };
}
