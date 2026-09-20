import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { envOptional } from "./env";
import type { StoredAlert } from "./notification-store";
import { isPostgresConfigured, query } from "./db";
import { dataFile } from "./paths";

function telegramConfigFile(): string {
  return dataFile("telegram.json");
}

let memoryTelegramConfig: { botToken: string; chatId: string } | null = null;

if (isPostgresConfigured()) {
  void (async () => {
    try {
      const rows = await query<{ bot_token: string; chat_id: string }>(
        "SELECT bot_token, chat_id FROM telegram_config WHERE id = 'primary' LIMIT 1",
      );
      const row = rows[0];
      if (row?.bot_token && row.chat_id) {
        memoryTelegramConfig = { botToken: row.bot_token, chatId: row.chat_id };
      }
    } catch (err) {
      console.error("[PostgreSQL] Hydration error for telegram_config:", err);
    }
  })();
}

export function getTelegramConfig(): { botToken: string; chatId: string } | null {
  if (memoryTelegramConfig) return memoryTelegramConfig;

  const file = telegramConfigFile();
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as {
        botToken?: string;
        chatId?: string;
      };
      if (data.botToken && data.chatId) {
        memoryTelegramConfig = { botToken: data.botToken, chatId: data.chatId };
        return memoryTelegramConfig;
      }
    } catch {
      // Malformed telegram.json: fall through to the TELEGRAM_* env vars.
    }
  }
  const botToken = envOptional("TELEGRAM_BOT_TOKEN");
  const chatId = envOptional("TELEGRAM_CHAT_ID");
  if (botToken && chatId) return { botToken, chatId };
  return null;
}

export function saveTelegramConfig(botToken: string, chatId: string): void {
  const cleanToken = botToken.trim();
  const cleanChatId = chatId.trim();
  memoryTelegramConfig = { botToken: cleanToken, chatId: cleanChatId };

  const file = telegramConfigFile();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ botToken: cleanToken, chatId: cleanChatId }, null, 2),
    "utf-8",
  );

  if (isPostgresConfigured()) {
    void query(
      `INSERT INTO telegram_config (id, bot_token, chat_id, updated_at)
       VALUES ('primary', $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         bot_token = EXCLUDED.bot_token,
         chat_id = EXCLUDED.chat_id,
         updated_at = NOW();`,
      [cleanToken, cleanChatId],
    ).catch((err) => console.error("[PostgreSQL] Telegram config sync error:", err));
  }
}

export const telegramConfigured = (): boolean => getTelegramConfig() !== null;

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

export async function sendTelegramRaw(text: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getTelegramConfig();
  if (!cfg) {
    return { ok: false, error: "Telegram bot token or chat ID is not configured." };
  }

  try {
    const token = cfg.botToken;
    const chatId = cfg.chatId;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (response.ok && result?.ok) {
      return { ok: true };
    }

    const errMsg = result?.description || `HTTP ${response.status} ${response.statusText}`;
    console.error("[Telegram] API error:", errMsg);
    return { ok: false, error: errMsg };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Network error";
    console.error("[Telegram] Network failure while sending message:", errMsg);
    return { ok: false, error: errMsg };
  }
}

export async function sendTelegramAlert(
  alert: StoredAlert,
): Promise<{ status: "sent" | "not_configured" | "failed"; error?: string }> {
  if (!telegramConfigured()) return { status: "not_configured" };
  const res = await sendTelegramRaw(formatAlertMessage(alert));
  return {
    status: res.ok ? "sent" : "failed",
    ...(res.error ? { error: res.error } : {}),
  };
}

export async function sendTelegramTestMessage(): Promise<{ ok: boolean; error?: string }> {
  const text =
    `✅ MT5 Monitor Telegram test successful.\n\n` +
    `Your Telegram notification channel is configured correctly.\n` +
    `Live trade activity for monitored clients will be delivered here.`;
  return sendTelegramRaw(text);
}
