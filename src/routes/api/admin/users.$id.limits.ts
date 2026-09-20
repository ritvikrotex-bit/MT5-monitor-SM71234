import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { getPublicUserById, updateUserLimits, type UserLimits } from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/users/$id/limits")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withAdminAuth(request, async (adminUser) => {
          const body = (await request.json()) as { limits: Partial<UserLimits> };
          if (!body.limits || typeof body.limits !== "object") {
            throw new ApiError("INVALID_INPUT", "Limits object is required.", 400);
          }

          const existing = getPublicUserById(params.id);
          if (!existing) {
            throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
          }

          if (
            (body.limits.maxBrokers !== undefined &&
              (typeof body.limits.maxBrokers !== "number" || body.limits.maxBrokers < 0)) ||
            (body.limits.maxMonitoredClients !== undefined &&
              (typeof body.limits.maxMonitoredClients !== "number" ||
                body.limits.maxMonitoredClients < 0))
          ) {
            throw new ApiError("INVALID_INPUT", "Limits must be non-negative numbers.", 400);
          }

          const updated = updateUserLimits(params.id, body.limits);

          logAudit({
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: "USER_LIMITS_UPDATE",
            targetType: "USER",
            targetId: params.id,
            details: {
              targetEmail: existing.email,
              newLimits: updated.limits,
            },
          });

          return jsonOk({ user: updated });
        }),
    },
  },
});
