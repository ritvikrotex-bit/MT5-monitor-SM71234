import { createFileRoute } from "@tanstack/react-router";
import { addUserBroker, listUserBrokers } from "@/server/brokers";
import { ApiError } from "@/server/errors";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/brokers")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => jsonOk({ brokers: listUserBrokers(user) })),
      POST: async ({ request }) =>
        withAuth(request, async (user) => {
          const body = (await request.json()) as {
            name?: string;
            server?: string;
            managerLogin?: string;
            password?: string;
          };
          if (!body.name || !body.server || !body.managerLogin || !body.password) {
            throw new ApiError(
              "INVALID_BROKER",
              "Broker name, server, manager login and password are required.",
              400,
            );
          }
          if (!/^\d+$/.test(body.managerLogin.trim())) {
            throw new ApiError(
              "INVALID_BROKER",
              "Manager login must be a numeric MT5 Manager account ID.",
              400,
            );
          }
          const broker = await addUserBroker(user, {
            name: body.name,
            server: body.server,
            managerLogin: body.managerLogin,
            password: body.password,
          });
          return jsonOk({ broker }, 201);
        }),
    },
  },
});
