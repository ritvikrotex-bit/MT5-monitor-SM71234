import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonError, jsonOk } from "@/server/errors";
import {
  authenticateUser,
  clearSessionCookie,
  createSessionToken,
  readSession,
  sessionCookie,
} from "@/server/session";
import { getUserById, publicUser, type UserRole } from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await readSession(request);
          if (!session) {
            return jsonOk({ user: null });
          }
          const stored = getUserById(session.id);
          if (!stored || stored.status === "DELETED") {
            const res = jsonOk({ user: null });
            res.headers.set("Set-Cookie", clearSessionCookie(request));
            return res;
          }
          return jsonOk({ user: publicUser(stored) });
        } catch (error) {
          return jsonError(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            email?: string;
            username?: string;
            identifier?: string;
            password?: string;
            role?: UserRole;
          };
          const identifier = body.identifier || body.email || body.username;
          if (!identifier || !body.password) {
            throw new ApiError("UNAUTHORIZED", "Username/email and password are required.", 400);
          }

          const clientIp =
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            request.headers.get("x-real-ip") ||
            "local";

          const user = authenticateUser(identifier, body.password, body.role, clientIp);
          const token = await createSessionToken(user);
          const fullUser = getUserById(user.id);

          const res = jsonOk({
            user: fullUser ? publicUser(fullUser) : user,
            redirect: user.role === "ADMIN" ? "/admin" : "/dashboard",
          });
          res.headers.set("Set-Cookie", sessionCookie(token, request));
          return res;
        } catch (error) {
          return jsonError(error);
        }
      },
      DELETE: async ({ request }) => {
        try {
          const session = await readSession(request);
          if (session) {
            logAudit({
              actorId: session.id,
              actorEmail: session.email,
              actorRole: session.role,
              action: "USER_LOGOUT",
              targetType: "USER",
              targetId: session.id,
            });
          }
          const res = jsonOk({ ok: true });
          res.headers.set("Set-Cookie", clearSessionCookie(request));
          return res;
        } catch (error) {
          return jsonError(error);
        }
      },
    },
  },
});
