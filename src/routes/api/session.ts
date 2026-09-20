import { createFileRoute } from "@tanstack/react-router";
import { ApiError, jsonError, jsonOk } from "@/server/errors";
import {
  authenticateLocal,
  clearSessionCookie,
  createSessionToken,
  sessionCookie,
} from "@/server/session";

export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { email?: string; password?: string };
          if (!body.email || !body.password) {
            throw new ApiError("UNAUTHORIZED", "Email and password are required.", 400);
          }
          const user = authenticateLocal(body.email, body.password);
          const token = await createSessionToken(user);
          const res = jsonOk({ user: { name: user.name, email: user.email } });
          res.headers.set("Set-Cookie", sessionCookie(token, request));
          return res;
        } catch (error) {
          return jsonError(error);
        }
      },
      DELETE: async ({ request }) => {
        const res = jsonOk({ ok: true });
        res.headers.set("Set-Cookie", clearSessionCookie(request));
        return res;
      },
    },
  },
});
