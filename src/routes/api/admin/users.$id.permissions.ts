import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import {
  getPublicUserById,
  updateUserPermissions,
  type UserPermissions,
} from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/users/$id/permissions")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withAdminAuth(request, async (adminUser) => {
          const body = (await request.json()) as { permissions: Partial<UserPermissions> };
          if (!body.permissions || typeof body.permissions !== "object") {
            throw new ApiError("INVALID_INPUT", "Permissions object is required.", 400);
          }

          const existing = getPublicUserById(params.id);
          if (!existing) {
            throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
          }

          const updated = updateUserPermissions(params.id, body.permissions);

          logAudit({
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: "USER_PERMISSIONS_UPDATE",
            targetType: "USER",
            targetId: params.id,
            details: {
              targetEmail: existing.email,
              newPermissions: updated.permissions,
            },
          });

          return jsonOk({ user: updated });
        }),
    },
  },
});
