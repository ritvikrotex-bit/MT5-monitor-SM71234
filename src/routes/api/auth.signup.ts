import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonError, jsonOk } from "@/server/errors";
import { clientIp as clientIpOf, signupLimiter } from "@/server/rate-limit";
import { createUser } from "@/server/user-store";
import { logAudit } from "@/server/audit-store";

export const Route = createFileRoute("/api/auth/signup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            name?: string;
            email?: string;
            username?: string;
            password?: string;
          };

          if (!body.name || !body.email || !body.username || !body.password) {
            throw new ApiError(
              "INVALID_INPUT",
              "Full name, email, username, and password are all required.",
              400,
            );
          }

          const clientIp = clientIpOf(request);
          const wait = signupLimiter.blockedFor(clientIp);
          if (wait > 0) {
            throw new ApiError(
              "TOO_MANY_ATTEMPTS",
              `Too many sign-up attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
              429,
            );
          }
          signupLimiter.hit(clientIp);

          const user = await createUser({
            name: body.name,
            email: body.email,
            username: body.username,
            password: body.password,
            role: "USER",
            status: "PENDING",
          });

          logAudit({
            actorId: user.id,
            actorEmail: user.email,
            actorRole: "USER",
            action: "USER_SIGNUP",
            targetType: "USER",
            targetId: user.id,
            details: { name: user.name, username: user.username },
            ipAddress: clientIp,
          });

          return jsonOk({
            success: true,
            status: "PENDING",
            message:
              "Your account has been created and is awaiting administrator approval. You will be able to log in once an admin activates your account.",
            user,
          });
        } catch (error) {
          return jsonError(error);
        }
      },
    },
  },
});
