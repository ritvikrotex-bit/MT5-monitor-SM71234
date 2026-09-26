import { createFileRoute } from "@tanstack/react-router";
import { logAudit } from "@/server/audit-store";
import { requireCopierPermission } from "@/server/copier-access";
import { pushCopierConfigQuietly } from "@/server/copier-client";
import { createCopierAccount, listCopierAccounts } from "@/server/copier-store";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/copier/accounts")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          return jsonOk({ accounts: listCopierAccounts(user.id) });
        }),

      POST: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const body = (await request.json()) as {
            label?: string;
            broker?: string;
            server?: string;
            login?: number | string;
            password?: string;
            role?: string;
          };
          const login = Number(body.login);
          if (
            !body.label ||
            !body.server ||
            !body.password ||
            !Number.isInteger(login) ||
            login <= 0
          ) {
            throw new ApiError(
              "INVALID_ACCOUNT",
              "A label, server, numeric MT5 login and password are all required.",
              400,
            );
          }
          const account = await createCopierAccount(user.id, {
            label: body.label,
            broker: body.broker ?? "",
            server: body.server,
            login,
            password: body.password,
            ...(body.role ? { role: body.role } : {}),
          });

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "COPIER_ACCOUNT_CREATE",
            targetType: "COPIER_ACCOUNT",
            targetId: account.id,
            // The password is deliberately absent: the audit log is plain text.
            details: {
              label: account.label,
              server: account.server,
              login: account.login,
              role: account.role,
            },
          });

          const warning = await pushCopierConfigQuietly();
          return jsonOk({ account, warning }, 201);
        }),
    },
  },
});
