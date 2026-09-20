import { createFileRoute } from "@tanstack/react-router";
import { brokerStatus } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id/status")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) => jsonOk({ broker: await brokerStatus(user, params.id) })),
    },
  },
});
