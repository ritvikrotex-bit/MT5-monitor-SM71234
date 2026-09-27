import { createFileRoute } from "@tanstack/react-router";
import { requireCopierPermission } from "@/server/copier-access";
import { copierAccountSymbols } from "@/server/copier-client";
import { getCopierAccount } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * What the destination broker actually offers.
 *
 * Symbol mappings are only useful when checked against the real list: a
 * mapping to a symbol the broker does not have fails at the moment a trade
 * arrives, which is the worst time to find out.
 */
export const Route = createFileRoute("/api/copier/accounts/$id/symbols")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          getCopierAccount(user.id, params.id); // ownership check
          const query = new URL(request.url).searchParams.get("q") ?? "";
          return jsonOk(await copierAccountSymbols(params.id, query));
        }),
    },
  },
});
