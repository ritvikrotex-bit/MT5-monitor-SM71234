import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { formatCopierTestResult } from "@/server/copier-alerts";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfig, testCopierLink, type CopierTestStep } from "@/server/copier-client";
import { getCopierLink } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";
import { sendTelegramText } from "@/server/telegram";
import { getUserById } from "@/server/user-store";

/**
 * Test run: check a link end to end without placing an order.
 *
 * The copier walks the real copy path — master readable, slave logged in and
 * allowed to trade, symbol mapping, lot size — and asks the broker to validate
 * a sample order with order_check, which places nothing. The result is then
 * sent to the owner's Telegram, which is the last thing worth checking: an
 * alert that never arrives looks exactly like a copier that is not working.
 */
export const Route = createFileRoute("/api/copier/links/$id/test")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const link = getCopierLink(user.id, params.id);
          // Test what is saved, not whatever the copier last heard.
          await pushCopierConfig();
          const result = await testCopierLink(link.id);

          let telegram: CopierTestStep;
          const owner = getUserById(user.id);
          if (owner?.permissions?.canUseTelegram === false) {
            telegram = {
              key: "telegram",
              title: "Telegram alerts",
              status: "warn",
              detail: "Telegram is switched off for your account by an administrator",
            };
          } else {
            const sent = await sendTelegramText(user.id, formatCopierTestResult(result), {
              html: true,
            });
            telegram =
              sent.status === "sent"
                ? {
                    key: "telegram",
                    title: "Telegram alerts",
                    status: "pass",
                    detail: "a test alert was sent to your Telegram chat",
                  }
                : sent.status === "not_configured"
                  ? {
                      key: "telegram",
                      title: "Telegram alerts",
                      status: "warn",
                      detail:
                        "Telegram is not set up, so copier alerts go nowhere (Settings → Telegram)",
                    }
                  : {
                      key: "telegram",
                      title: "Telegram alerts",
                      status: "fail",
                      detail: `the test alert could not be delivered: ${sent.error ?? "unknown error"}`,
                    };
          }
          const steps = [...result.steps, telegram];

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_LINK_TEST",
            targetType: "COPIER_LINK",
            targetId: link.id,
            details: {
              label: link.label,
              ok: result.ok,
              failed: steps.filter((s) => s.status === "fail").map((s) => s.key),
            },
          });

          return jsonOk({ ...result, ok: steps.every((s) => s.status !== "fail"), steps });
        }),
    },
  },
});
