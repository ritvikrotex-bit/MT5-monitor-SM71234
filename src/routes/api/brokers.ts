import { createFileRoute } from "@tanstack/react-router";
import { addUserBroker, listUserBrokers } from "@/server/brokers";
import { ApiError, jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";
import { getUserById } from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/brokers")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => jsonOk({ brokers: listUserBrokers(user) })),
      POST: async ({ request }) =>
        withAuth(request, async (user) => {
          const liveUser = getUserById(user.id);
          // Applies to every role: an ADMIN is an oversight account and is not meant to hold brokers.
          if (liveUser) {
            if (liveUser.permissions?.canAddBroker === false) {
              throw new ApiError(
                "FORBIDDEN",
                "You do not have permission to add brokers. Please contact your administrator.",
                403,
              );
            }
            const existingBrokers = listUserBrokers(user);
            const maxBrokers = liveUser.limits?.maxBrokers ?? 5;
            if (existingBrokers.length >= maxBrokers) {
              throw new ApiError(
                "LIMIT_EXCEEDED",
                `Broker limit reached. Your account is restricted to ${maxBrokers} broker${maxBrokers === 1 ? "" : "s"}.`,
                403,
              );
            }
          }

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

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "BROKER_CREATE",
            targetType: "BROKER",
            targetId: broker.id,
            details: { name: broker.name, server: broker.server },
          });

          return jsonOk({ broker }, 201);
        }),
    },
  },
});
