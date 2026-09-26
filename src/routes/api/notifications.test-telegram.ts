import { createFileRoute } from "@tanstack/react-router";
import { sendTelegramTestMessage, telegramSummary } from "@/server/telegram";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";
import { getUserById } from "@/server/user-store";

// Test message to the signed-in user's own Telegram (same as POST /api/notifications).
export const Route = createFileRoute("/api/notifications/test-telegram")({
  server: {
    handlers: {
      POST: ({ request }) =>
        withAuth(request, async (user) => {
          if (getUserById(user.id)?.permissions?.canUseTelegram === false) {
            throw new ApiError(
              "FORBIDDEN",
              "Telegram alerts are disabled for your account. Please contact your administrator.",
              403,
            );
          }
          if (!(await telegramSummary(user.id)).configured) {
            throw new ApiError(
              "TELEGRAM_NOT_CONFIGURED",
              "Set up your Telegram bot token and chat ID first.",
              400,
            );
          }
          const result = await sendTelegramTestMessage(user.id);
          if (!result.ok) {
            throw new ApiError(
              "TELEGRAM_SEND_FAILED",
              result.error || "Failed to send test message via Telegram.",
              502,
            );
          }
          return jsonOk({ ok: true, message: "Telegram test notification sent successfully." });
        }),
    },
  },
});
