import { createFileRoute } from "@tanstack/react-router";
import { getClient } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id/clients/$login")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) =>
          jsonOk({ client: await getClient(user, params.id, params.login) }),
        ),
    },
  },
});
