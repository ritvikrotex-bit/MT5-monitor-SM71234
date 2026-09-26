import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfigQuietly } from "@/server/copier-client";
import { deleteCopierAccount, updateCopierAccount } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/copier/accounts/$id")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const body = (await request.json()) as {
            label?: string;
            broker?: string;
            server?: string;
            login?: number;
            password?: string;
          };
          const account = await updateCopierAccount(user.id, params.id, body);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_ACCOUNT_UPDATE",
            targetType: "COPIER_ACCOUNT",
            targetId: account.id,
            details: { label: account.label, passwordChanged: Boolean(body.password) },
          });

          const warning = await pushCopierConfigQuietly();
          return jsonOk({ account, warning });
        }),

      DELETE: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          deleteCopierAccount(user.id, params.id);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_ACCOUNT_DELETE",
            targetType: "COPIER_ACCOUNT",
            targetId: params.id,
            details: {},
          });

          const warning = await pushCopierConfigQuietly();
          return jsonOk({ ok: true, warning });
        }),
    },
  },
});
