import { createFileRoute } from "@tanstack/react-router";
import { testSavedBroker } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id/test-connection")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        withAuth(request, async (user) =>
          jsonOk({ broker: await testSavedBroker(user, params.id) }),
        ),
    },
  },
});
