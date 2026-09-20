import { createFileRoute } from "@tanstack/react-router";
import { listAlerts } from "@/server/notification-store";
import {
  getTelegramConfig,
  saveTelegramConfig,
  sendTelegramTestMessage,
  telegramConfigured,
} from "@/server/telegram";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async (user) => {
          const cfg = getTelegramConfig();
          return jsonOk({
            alerts: listAlerts(user.id),
            telegramConfigured: telegramConfigured(),
            chatId: cfg?.chatId ?? null,
          });
        }),
      POST: ({ request }) =>
        withAuth(request, async (_user) => {
          if (!telegramConfigured()) {
            return jsonOk(
              { ok: false, error: "Telegram bot token or chat ID is not configured." },
              400,
            );
          }
          const res = await sendTelegramTestMessage();
          return jsonOk(res, res.ok ? 200 : 502);
        }),
      PUT: ({ request }) =>
        withAuth(request, async (_user) => {
          const body = (await request.json().catch(() => ({}))) as {
            botToken?: string;
            chatId?: string;
          };
          if (!body.botToken || !body.chatId) {
            throw new ApiError("INVALID_INPUT", "Bot token and Chat ID are required.", 400);
          }
          saveTelegramConfig(body.botToken, body.chatId);
          const res = await sendTelegramTestMessage();
          return jsonOk({
            ok: res.ok,
            telegramConfigured: true,
            chatId: body.chatId,
            message: res.ok
              ? "Telegram configuration saved and test message delivered!"
              : `Configuration saved, but test message failed: ${res.error || "Unknown error"}`,
            error: res.error,
          });
        }),
    },
  },
});
