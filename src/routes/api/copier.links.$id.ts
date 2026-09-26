import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfig, pushCopierConfigQuietly } from "@/server/copier-client";
import {
  deleteCopierLink,
  getCopierLink,
  updateCopierLink,
  type CopierRules,
} from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/copier/links/$id")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const before = getCopierLink(user.id, params.id);
          const body = (await request.json()) as {
            label?: string;
            rules?: Partial<CopierRules>;
            enabled?: boolean;
            dryRun?: boolean;
            maxDrawdownPct?: number;
          };
          const link = updateCopierLink(user.id, params.id, body);

          // Turning off dry run, or arming the link, is the moment real money
          // starts moving. Record those two transitions explicitly.
          const wentLive = before.dryRun && !link.dryRun;
          const wasArmed = !before.enabled && link.enabled;
          if (wentLive || wasArmed || body.rules) {
            logAudit({
              actorId: user.id,
              actorEmail: user.email,
              actorRole: user.role,
              action: wentLive
                ? "COPIER_LINK_LIVE"
                : wasArmed
                  ? "COPIER_LINK_ENABLE"
                  : "COPIER_LINK_UPDATE",
              targetType: "COPIER_LINK",
              targetId: link.id,
              details: {
                label: link.label,
                enabled: link.enabled,
                dryRun: link.dryRun,
                lotMode: link.rules.lotMode,
                lotValue: link.rules.lotValue,
                maxLot: link.rules.maxLot,
              },
            });
          }

          // An enable must reach the service to mean anything, so this one is
          // allowed to fail loudly rather than being swallowed.
          if (wentLive || wasArmed) {
            await pushCopierConfig();
            return jsonOk({ link, warning: null });
          }
          const warning = await pushCopierConfigQuietly();
          return jsonOk({ link, warning });
        }),

      DELETE: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          deleteCopierLink(user.id, params.id);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_LINK_DELETE",
            targetType: "COPIER_LINK",
            targetId: params.id,
            details: {},
          });

          const warning = await pushCopierConfigQuietly();
          return jsonOk({ ok: true, warning });
        }),
    },
  },
});
