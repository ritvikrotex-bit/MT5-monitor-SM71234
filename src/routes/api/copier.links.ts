import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfigQuietly } from "@/server/copier-client";
import { createCopierLink, listCopierLinks, type CopierRules } from "@/server/copier-store";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/copier/links")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          return jsonOk({ links: listCopierLinks(user.id) });
        }),

      POST: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const body = (await request.json()) as {
            label?: string;
            masterBrokerId?: string;
            masterLogin?: number | string;
            destAccountId?: string;
            rules?: Partial<CopierRules>;
            maxDrawdownPct?: number;
          };
          const masterLogin = Number(body.masterLogin);
          if (
            !body.label ||
            !body.masterBrokerId ||
            !body.destAccountId ||
            !Number.isInteger(masterLogin) ||
            masterLogin <= 0
          ) {
            throw new ApiError(
              "INVALID_LINK",
              "A label, the master's broker and MT5 login, and a destination account are all required.",
              400,
            );
          }
          const link = createCopierLink(user.id, {
            label: body.label,
            masterBrokerId: body.masterBrokerId,
            masterLogin,
            destAccountId: body.destAccountId,
            ...(body.rules ? { rules: body.rules } : {}),
            ...(body.maxDrawdownPct !== undefined ? { maxDrawdownPct: body.maxDrawdownPct } : {}),
          });

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_LINK_CREATE",
            targetType: "COPIER_LINK",
            targetId: link.id,
            details: {
              label: link.label,
              masterBroker: link.masterBrokerId,
              masterLogin: link.masterLogin,
              destination: link.destAccountId,
              lotMode: link.rules.lotMode,
              lotValue: link.rules.lotValue,
            },
          });

          const warning = await pushCopierConfigQuietly();
          return jsonOk({ link, warning }, 201);
        }),
    },
  },
});
