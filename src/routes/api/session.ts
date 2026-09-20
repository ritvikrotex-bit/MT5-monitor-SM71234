import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonError, jsonOk } from "@/server/errors";
import { clientIp as clientIpOf, loginLimiter } from "@/server/rate-limit";
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

          const clientIp = clientIpOf(request);
          const wait = loginLimiter.blockedFor(clientIp);
          if (wait > 0) {
            throw new ApiError(
              "TOO_MANY_ATTEMPTS",
              `Too many failed sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
              429,
            );
          }

          let user;
          try {
            user = authenticateUser(identifier, body.password, body.role, clientIp);
          } catch (error) {
            // Only wrong credentials count; a valid login to a pending/suspended account does not.
            if (error instanceof ApiError && error.status === 401) loginLimiter.hit(clientIp);
            throw error;
          }
          loginLimiter.reset(clientIp);
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
