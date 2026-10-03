import { createFileRoute } from "@tanstack/react-router";
import { requireCopierPermission } from "@/server/copier-access";
import { probeCopierAccount, pushCopierConfig } from "@/server/copier-client";
import { getCopierAccount } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * Log in to an account and report what it looks like. Places no orders.
 *
 * This is what tells an operator, before anything is armed, whether the
 * account is a demo or real-money one, whether it is hedging, and whether it
 * is even allowed to trade.
 */
export const Route = createFileRoute("/api/copier/accounts/$id/probe")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          // Ownership check before touching the service.
          getCopierAccount(user.id, params.id);
          // Push first so the service has this account even if the push made
          // when it was saved failed (the copier was down at the time).
          await pushCopierConfig();
          const snapshot = await probeCopierAccount(params.id);
          return jsonOk(snapshot);
        }),
    },
  },
});
