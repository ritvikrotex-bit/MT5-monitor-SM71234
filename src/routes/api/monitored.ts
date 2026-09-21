import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import {
  isMonitored,
  liveMonitoredClients,
  monitorClient,
  unmonitorClient,
} from "@/server/monitored";
import { withAuth } from "@/server/http";
import { getUserById } from "@/server/user-store";
import { listAllMonitored, listMonitored } from "@/server/monitor-store";
import { listAllBrokers } from "@/server/broker-store";
import { logAudit } from "@/server/audit-store";

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
          const liveUser = getUserById(user.id);
          // Applies to every role: an ADMIN oversees the platform rather than monitoring clients itself.
          if (liveUser) {
            if (liveUser.permissions?.canMonitorClients === false) {
              throw new ApiError(
                "FORBIDDEN",
                "You do not have permission to monitor clients. Please contact your administrator.",
                403,
              );
            }
            const currentMonitored = listMonitored(user.id);
            const maxMonitored = liveUser.limits?.maxMonitoredClients ?? 25;
            if (currentMonitored.length >= maxMonitored) {
              throw new ApiError(
                "LIMIT_EXCEEDED",
                `Monitored client limit reached. Your account is restricted to ${maxMonitored} monitored client${maxMonitored === 1 ? "" : "s"}.`,
                403,
              );
            }
          }

          const body = (await request.json()) as { brokerId?: string; login?: number };
          if (!body.brokerId || typeof body.login !== "number" || !Number.isInteger(body.login)) {
            throw new ApiError(
              "INVALID_MONITOR",
              "Broker and numeric client login are required.",
              400,
            );
          }
          const login = body.login;

          // One watcher per client account across the platform. Alerts go to a single shared
          // Telegram group, so a second watcher would poll the broker twice and split the alert
          // history between two operators while the duplicate alert is suppressed anyway.
          const allBrokers = listAllBrokers();
          const serverOf = (id: string) => allBrokers.find((b) => b.id === id)?.server;
          const targetServer = serverOf(body.brokerId);
          const clash = listAllMonitored().find(
            (m) =>
              m.login === login && m.userId !== user.id && serverOf(m.brokerId) === targetServer,
          );
          if (clash) {
            const owner = getUserById(clash.userId);
            throw new ApiError(
              "ALREADY_MONITORED",
              `Account ${login} on this server is already monitored by ${owner?.email ?? "another operator"}. Each account is watched once across the platform.`,
              409,
            );
          }

          await monitorClient(user, body.brokerId, login);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "MONITOR_ADD",
            targetType: "MONITOR",
            targetId: `${body.brokerId}:${login}`,
            details: { brokerId: body.brokerId, login },
          });

          return jsonOk({ monitored: isMonitored(user, body.brokerId, login) }, 201);
        }),
      DELETE: ({ request }) =>
        withAuth(request, async (user) => {
          const url = new URL(request.url);
          const brokerId = url.searchParams.get("brokerId");
          const login = Number(url.searchParams.get("login"));
          if (!brokerId || !Number.isInteger(login)) {
            throw new ApiError(
              "INVALID_MONITOR",
              "Broker and numeric client login are required.",
              400,
            );
          }
          unmonitorClient(user, brokerId, login);

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: user.role,
            action: "MONITOR_REMOVE",
            targetType: "MONITOR",
            targetId: `${brokerId}:${login}`,
            details: { brokerId, login },
          });

          return jsonOk({ monitored: false });
        }),
    },
  },
});
