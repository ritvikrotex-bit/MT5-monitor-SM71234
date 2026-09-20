import { createFileRoute } from "@tanstack/react-router";
import { listAlerts } from "@/server/notification-store";
import {
  getTelegramConfig,
  saveTelegramConfig,
  sendTelegramTestMessage,
  telegramConfigured,
} from "@/server/telegram";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth, withAuth } from "@/server/http";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async (user) => {
          const cfg = getTelegramConfig();
          return jsonOk({
            alerts: listAlerts(user.id),
            telegramConfigured: telegramConfigured(),
            chatId: user.role === "ADMIN" ? (cfg?.chatId ?? null) : null,
          });
        }),
      POST: ({ request }) =>
        withAdminAuth(request, async (admin) => {
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
        withAdminAuth(request, async (admin) => {
          const body = (await request.json().catch(() => ({}))) as {
            botToken?: string;
            chatId?: string;
          };
          if (!body.botToken || !body.chatId) {
            throw new ApiError("INVALID_INPUT", "Bot token and Chat ID are required.", 400);
          }
          saveTelegramConfig(body.botToken, body.chatId);
          logAudit({
            actorId: admin.id,
            actorEmail: admin.email,
            actorRole: admin.role,
            action: "TELEGRAM_CONFIG_UPDATE",
            targetType: "SYSTEM",
            details: { chatId: body.chatId },
          });
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
