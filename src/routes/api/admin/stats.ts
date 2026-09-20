import { createFileRoute } from "@tanstack/react-router";
import { jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { listAllUsersIncludingDeleted } from "@/server/user-store";
import { listAllBrokers } from "@/server/broker-store";
import { listAllMonitored } from "@/server/monitor-store";
import { getRecentAuditLogs } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/stats")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAdminAuth(request, async () => {
          const users = listAllUsersIncludingDeleted().filter((u) => u.status !== "DELETED");
          const totalUsers = users.length;
          const activeUsers = users.filter((u) => u.status === "ACTIVE").length;
          const pendingUsers = users.filter((u) => u.status === "PENDING").length;
          const suspendedUsers = users.filter((u) => u.status === "SUSPENDED").length;

          const brokers = listAllBrokers();
          const totalBrokers = brokers.length;
          const connectedBrokers = brokers.filter((b) => b.status === "CONNECTED").length;
          const disconnectedBrokers = totalBrokers - connectedBrokers;

          const monitored = listAllMonitored();
          const totalMonitored = monitored.length;

          const recentLogs = getRecentAuditLogs(10);

          return jsonOk({
            users: {
              total: totalUsers,
              active: activeUsers,
              pending: pendingUsers,
              suspended: suspendedUsers,
            },
            brokers: {
              total: totalBrokers,
              connected: connectedBrokers,
              disconnected: disconnectedBrokers,
            },
            monitored: {
              total: totalMonitored,
            },
            recentActivity: recentLogs,
            timestamp: new Date().toISOString(),
          });
        }),
    },
  },
});
