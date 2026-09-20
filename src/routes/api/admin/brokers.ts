import { createFileRoute } from "@tanstack/react-router";
import { jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { listAllBrokers } from "@/server/broker-store";
import { getUserById } from "@/server/user-store";

export const Route = createFileRoute("/api/admin/brokers")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAdminAuth(request, async () => {
          const brokers = listAllBrokers();
          const enriched = brokers.map((b) => {
            const owner = getUserById(b.ownerUserId);
            return {
              ...b,
              ownerName: owner?.name || "Unknown",
              ownerEmail: owner?.email || "Unknown",
              ownerRole: owner?.role || "USER",
              ownerStatus: owner?.status || "UNKNOWN",
            };
          });

          return jsonOk({ brokers: enriched });
        }),
    },
  },
});
