import { createFileRoute } from "@tanstack/react-router";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";
import { getUserById, publicUser } from "@/server/user-store";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async (user) => {
          const live = getUserById(user.id);
          return jsonOk({
            user: live ? publicUser(live) : user,
          });
        }),
    },
  },
});
