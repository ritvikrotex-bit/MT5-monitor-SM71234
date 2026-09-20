import { createFileRoute } from "@tanstack/react-router";
import { getUserBroker, patchUserBroker, removeUserBroker } from "@/server/brokers";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        withAuth(request, async (user) => jsonOk({ broker: getUserBroker(user, params.id) })),
      PUT: async ({ request, params }) =>
        withAuth(request, async (user) => {
          const body = (await request.json()) as {
            name?: string;
            server?: string;
            managerLogin?: string;
            password?: string;
          };
          const broker = await patchUserBroker(user, params.id, body);
          return jsonOk({ broker });
        }),
      DELETE: async ({ request, params }) =>
        withAuth(request, async (user) => {
          await removeUserBroker(user, params.id);
          return jsonOk({ ok: true });
        }),
    },
  },
});
