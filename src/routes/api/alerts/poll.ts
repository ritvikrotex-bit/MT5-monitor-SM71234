import { createFileRoute } from "@tanstack/react-router";
import { pollAllAlerts } from "@/server/alerting";
import { envOptional } from "@/server/env";
import { ApiError, jsonError, jsonOk } from "@/server/errors";

export const Route = createFileRoute("/api/alerts/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const secret = envOptional("MONITOR_POLL_SECRET");
          if (!secret || request.headers.get("X-Monitor-Poll-Secret") !== secret)
            throw new ApiError("UNAUTHORIZED", "Polling is not authorized.", 401);
          return jsonOk(await pollAllAlerts());
        } catch (error) {
          return jsonError(error);
        }
      },
    },
  },
});
