import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfigQuietly } from "@/server/copier-client";
import {
  createCopierLink,
  listCopierLinks,
  type CopierMaster,
  type CopierRules,
} from "@/server/copier-store";
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
            master?: CopierMaster;
            destAccountId?: string;
            rules?: Partial<CopierRules>;
            maxDrawdownPct?: number;
          };
          if (!body.label || !body.master || !body.destAccountId) {
            throw new ApiError(
              "INVALID_LINK",
              "A label, a master and a destination account are all required.",
              400,
            );
          }
          const link = createCopierLink(user.id, {
            label: body.label,
            master: body.master,
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
              master: link.master,
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
