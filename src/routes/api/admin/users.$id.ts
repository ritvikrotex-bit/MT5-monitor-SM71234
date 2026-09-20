import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { getPublicUserById, updateUserStatus } from "@/server/user-store";
import { listBrokers } from "@/server/broker-store";
import { listMonitored } from "@/server/monitor-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/users/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withAdminAuth(request, async () => {
          const user = getPublicUserById(params.id);
          if (!user || user.status === "DELETED") {
            throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
          }

          const brokers = listBrokers(user.id);
          const monitored = listMonitored(user.id);

          return jsonOk({
            user,
            brokers,
            monitored,
          });
        }),

      DELETE: ({ request, params }) =>
        withAdminAuth(request, async (adminUser) => {
          if (params.id === adminUser.id) {
            throw new ApiError("INVALID_ACTION", "You cannot delete your own admin account.", 400);
          }

          const user = getPublicUserById(params.id);
          if (!user) {
            throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
          }

          const updated = updateUserStatus(params.id, "DELETED", adminUser.email);

          logAudit({
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: "USER_DELETE",
            targetType: "USER",
            targetId: params.id,
            details: { targetEmail: user.email },
          });

          return jsonOk({ user: updated });
        }),
    },
  },
});
