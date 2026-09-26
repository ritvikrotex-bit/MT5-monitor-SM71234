import { createFileRoute } from "@tanstack/react-router";
import { listAlerts } from "@/server/notification-store";
import {
  deleteTelegramConfig,
  isValidBotToken,
  isValidChatId,
  saveTelegramConfig,
  sendTelegramTestMessage,
  telegramSummary,
  verifyTelegramCredentials,
} from "@/server/telegram";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";
import { logAudit } from "@/server/audit-store";
import { getUserById } from "@/server/user-store";
import type { SessionUser } from "@/server/session";

// Telegram is per user: each account stores its own bot token and chat id, and alerts for that
// account's monitored clients go only to that chat. An admin can switch it off per user.
function requireTelegramPermission(user: SessionUser): void {
  const live = getUserById(user.id);
  if (live && live.permissions?.canUseTelegram === false) {
    throw new ApiError(
      "FORBIDDEN",
      "Telegram alerts are disabled for your account. Please contact your administrator.",
      403,
    );
  }
}

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      // Alerts + this user's Telegram status (their own chat id, never the token).
      GET: ({ request }) =>
        withAuth(request, async (user) => {
          const telegram = await telegramSummary(user.id);
          return jsonOk({
            alerts: listAlerts(user.id),
            telegramConfigured: telegram.configured,
            chatId: telegram.chatId,
          });
        }),

      // Send a test message to this user's saved Telegram.
      POST: ({ request }) =>
        withAuth(request, async (user) => {
          requireTelegramPermission(user);
          if (!(await telegramSummary(user.id)).configured) {
            return jsonOk(
              { ok: false, error: "Set up your Telegram bot token and chat ID first." },
              400,
            );
          }
          const res = await sendTelegramTestMessage(user.id);
          return jsonOk(
            { ...res, message: res.ok ? "Test message delivered to your Telegram." : res.error },
            res.ok ? 200 : 502,
          );
        }),

      // Save this user's bot token + chat id. The credentials are verified with a real test message
      // first, so a typo never replaces a working setup.
      PUT: ({ request }) =>
        withAuth(request, async (user) => {
          requireTelegramPermission(user);
          const body = (await request.json().catch(() => ({}))) as {
            botToken?: string;
            chatId?: string;
          };
          const botToken = (body.botToken ?? "").trim();
          const chatId = (body.chatId ?? "").trim();
          if (!botToken || !chatId) {
            throw new ApiError("INVALID_INPUT", "Bot token and Chat ID are required.", 400);
          }
          if (!isValidBotToken(botToken)) {
            throw new ApiError(
              "INVALID_BOT_TOKEN",
              "That doesn't look like a Telegram bot token. It looks like 123456789:AA… and comes from @BotFather.",
              400,
            );
          }
          if (!isValidChatId(chatId)) {
            throw new ApiError(
              "INVALID_CHAT_ID",
              "Chat ID must be a number (groups start with -) or a @channelname.",
              400,
            );
          }

          const check = await verifyTelegramCredentials(botToken, chatId);
          if (!check.ok) {
            return jsonOk(
              {
                ok: false,
                telegramConfigured: (await telegramSummary(user.id)).configured,
                message: `Not saved: Telegram rejected these details (${check.error ?? "unknown error"}). Make sure the bot is added to the chat and you have sent it a message.`,
                error: check.error,
              },
              400,
            );
          }

          await saveTelegramConfig(user.id, botToken, chatId);
          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "TELEGRAM_CONFIG_UPDATE",
            targetType: "NOTIFICATION",
            targetId: user.id,
            details: { chatId },
          });
          return jsonOk({
            ok: true,
            telegramConfigured: true,
            chatId,
            message: "Telegram connected. A test message was delivered to your chat.",
          });
        }),

      // Remove this user's Telegram setup.
      DELETE: ({ request }) =>
        withAuth(request, async (user) => {
          const removed = await deleteTelegramConfig(user.id);
          if (removed) {
            logAudit({
              actorId: user.id,
              actorEmail: user.email,
              actorRole: user.role,
              action: "TELEGRAM_CONFIG_UPDATE",
              targetType: "NOTIFICATION",
              targetId: user.id,
              details: { removed: true },
            });
          }
          return jsonOk({ ok: true, telegramConfigured: false, message: "Telegram disconnected." });
        }),
    },
  },
});
