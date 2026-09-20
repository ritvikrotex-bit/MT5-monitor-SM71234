import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import {
  createUser,
  listAllUsersIncludingDeleted,
  type UserPermissions,
  type UserLimits,
  type UserRole,
  type UserStatus,
} from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/users")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAdminAuth(request, async () => {
          const url = new URL(request.url);
          const q = url.searchParams.get("q")?.toLowerCase().trim() || "";
          const status = url.searchParams.get("status") || "";
          const role = url.searchParams.get("role") || "";

          let users = listAllUsersIncludingDeleted().filter((u) => u.status !== "DELETED");

          if (q) {
            users = users.filter(
              (u) =>
                u.name.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q) ||
                u.username.toLowerCase().includes(q),
            );
          }

          if (status && status !== "ALL") {
            users = users.filter((u) => u.status === status);
          }

          if (role && role !== "ALL") {
            users = users.filter((u) => u.role === role);
          }

          return jsonOk({ users });
        }),

      POST: ({ request }) =>
        withAdminAuth(request, async (adminUser) => {
          const body = (await request.json()) as {
            name: string;
            email: string;
            username: string;
            password: string;
            role?: UserRole;
            status?: UserStatus;
            permissions?: Partial<UserPermissions>;
            limits?: Partial<UserLimits>;
          };

          if (!body.name || !body.email || !body.username || !body.password) {
            throw new ApiError(
              "INVALID_INPUT",
              "Name, email, username, and password are required.",
              400,
            );
          }

          const user = await createUser({
            name: body.name,
            email: body.email,
            username: body.username,
            password: body.password,
            role: body.role || "USER",
            status: body.status || "ACTIVE",
            ...(body.permissions ? { permissions: body.permissions } : {}),
            ...(body.limits ? { limits: body.limits } : {}),
          });

          logAudit({
            actorId: adminUser.id,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: "USER_SIGNUP",
            targetType: "USER",
            targetId: user.id,
            details: { createdByAdmin: true, role: user.role, status: user.status },
          });

          return jsonOk({ user }, 201);
        }),
    },
  },
});
