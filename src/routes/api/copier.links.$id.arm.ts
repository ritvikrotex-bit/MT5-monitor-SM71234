import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { armCopierLink } from "@/server/copier-client";
import { getCopierLink } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * Clear a halt so a stopped link runs again.
 *
 * Arming resumes from the present: whatever the master holds at that moment is
 * left alone, so re-arming after a drawdown halt does not pile straight back
 * into the trades that caused it.
 */
export const Route = createFileRoute("/api/copier/links/$id/arm")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const link = getCopierLink(user.id, params.id);
          await armCopierLink(link.id);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_LINK_ARM",
            targetType: "COPIER_LINK",
            targetId: link.id,
            details: { label: link.label },
          });

          return jsonOk({ ok: true });
        }),
    },
  },
});
