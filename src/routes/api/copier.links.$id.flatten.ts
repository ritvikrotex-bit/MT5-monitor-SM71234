import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { flattenCopierLink } from "@/server/copier-client";
import { getCopierLink } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * Close every destination position this link owns. The master is untouched,
 * and positions belonging to anyone else are left alone.
 */
export const Route = createFileRoute("/api/copier/links/$id/flatten")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const link = getCopierLink(user.id, params.id);
          const result = await flattenCopierLink(link.id);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_LINK_FLATTEN",
            targetType: "COPIER_LINK",
            targetId: link.id,
            details: { label: link.label, closed: result.closed, remaining: result.remaining },
          });

          return jsonOk(result);
        }),
    },
  },
});
