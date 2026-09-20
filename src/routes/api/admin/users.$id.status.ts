import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { getPublicUserById, updateUserStatus, type UserStatus } from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/users/$id/status")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withAdminAuth(request, async (adminUser) => {
          const body = (await request.json()) as { status: UserStatus };
          const validStatuses: UserStatus[] = ["ACTIVE", "PENDING", "SUSPENDED", "DELETED"];

          if (!body.status || !validStatuses.includes(body.status)) {
            throw new ApiError(
              "INVALID_STATUS",
              "Status must be ACTIVE, PENDING, SUSPENDED, or DELETED.",
              400,
            );
          }

          if (params.id === adminUser.id && body.status !== "ACTIVE") {
            throw new ApiError(
              "INVALID_ACTION",
              "You cannot change the status of your own admin account.",
              400,
            );
          }

          const existing = getPublicUserById(params.id);
          if (!existing) {
            throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
          }

          const previousStatus = existing.status;
          const updated = updateUserStatus(params.id, body.status, adminUser.email);

          logAudit({
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: "USER_STATUS_CHANGE",
            targetType: "USER",
            targetId: params.id,
            details: {
              previousStatus,
              newStatus: body.status,
              targetEmail: existing.email,
            },
          });

          return jsonOk({ user: updated });
        }),
    },
  },
});
