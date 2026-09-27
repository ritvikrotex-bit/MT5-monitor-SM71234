import { createFileRoute } from "@tanstack/react-router";
import { requireCopierPermission } from "@/server/copier-access";
import { copierLinkPreview } from "@/server/copier-client";
import { getCopierLink } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * Preview how this link translates symbols, before a trade depends on it.
 *
 * Reads only: it asks the master's server and the destination terminal what
 * they offer and runs the link's own rules over the answer.
 */
export const Route = createFileRoute("/api/copier/links/$id/preview")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          getCopierLink(user.id, params.id); // ownership check
          const url = new URL(request.url);
          return jsonOk(
            await copierLinkPreview(
              params.id,
              url.searchParams.get("q") ?? "",
              Number(url.searchParams.get("limit") ?? 400),
            ),
          );
        }),
    },
  },
});
