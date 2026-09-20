import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import {
  isMonitored,
  liveMonitoredClients,
  monitorClient,
  unmonitorClient,
} from "@/server/monitored";
import { withAuth } from "@/server/http";

export const Route = createFileRoute("/api/monitored")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async (user) => {
          const url = new URL(request.url);
          const brokerId = url.searchParams.get("brokerId");
          const login = Number(url.searchParams.get("login"));
          return brokerId && Number.isInteger(login)
            ? jsonOk({ monitored: isMonitored(user, brokerId, login) })
            : jsonOk(await liveMonitoredClients(user));
        }),
      POST: ({ request }) =>
        withAuth(request, async (user) => {
          const body = (await request.json()) as { brokerId?: string; login?: number };
          if (!body.brokerId || typeof body.login !== "number" || !Number.isInteger(body.login)) {
            throw new ApiError(
              "INVALID_MONITOR",
              "Broker and numeric client login are required.",
              400,
            );
          }
          const login = body.login;
          await monitorClient(user, body.brokerId, login);
          return jsonOk({ monitored: isMonitored(user, body.brokerId, login) }, 201);
        }),
      DELETE: ({ request }) =>
        withAuth(request, async (user) => {
          const url = new URL(request.url);
          const brokerId = url.searchParams.get("brokerId");
          const login = Number(url.searchParams.get("login"));
          if (!brokerId || !Number.isInteger(login))
            throw new ApiError(
              "INVALID_MONITOR",
              "Broker and numeric client login are required.",
              400,
            );
          unmonitorClient(user, brokerId, login);
          return jsonOk({ monitored: false });
        }),
    },
  },
});
