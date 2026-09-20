import { createFileRoute } from "@tanstack/react-router";
import { getClientPositions } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id/clients/$login/positions")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) =>
          jsonOk(await getClientPositions(user, params.id, params.login)),
        ),
    },
  },
});
