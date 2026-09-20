import { createFileRoute } from "@tanstack/react-router";
import { sendTelegramTestMessage, telegramConfigured } from "@/server/telegram";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/notifications/test-telegram")({
  server: {
    handlers: {
      POST: ({ request }) =>
        withAuth(request, async (_user) => {
          if (!telegramConfigured()) {
            throw new ApiError(
              "TELEGRAM_NOT_CONFIGURED",
              "Telegram bot token or chat ID is not configured on the server.",
              400,
            );
          }
          const result = await sendTelegramTestMessage();
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
