import { createFileRoute } from "@tanstack/react-router";
import { searchClients } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id/clients/search")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) => {
          const url = new URL(request.url);
          const q = url.searchParams.get("q") ?? "";
          const by = url.searchParams.get("by");
          return jsonOk(await searchClients(user, params.id, q, by));
        }),
    },
  },
});
