import { createFileRoute } from "@tanstack/react-router";
import { jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { listAllMonitored } from "@/server/monitor-store";
import { listAllBrokers } from "@/server/broker-store";
import { getUserById } from "@/server/user-store";

export const Route = createFileRoute("/api/admin/monitored")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAdminAuth(request, async () => {
          const monitored = listAllMonitored();
          const allBrokers = listAllBrokers();

          const enriched = monitored.map((m) => {
            const owner = getUserById(m.userId);
            const broker = allBrokers.find((b) => b.id === m.brokerId);
            return {
              ...m,
              ownerName: owner?.name || "Unknown",
              ownerEmail: owner?.email || "Unknown",
              brokerName: broker?.name || "Unknown Broker",
              brokerServer: broker?.server || "Unknown Server",
              brokerStatus: broker?.status || "UNKNOWN",
            };
          });

          return jsonOk({ monitored: enriched });
        }),
    },
  },
});
