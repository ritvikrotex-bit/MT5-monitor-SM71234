import { createFileRoute } from "@tanstack/react-router";
import { jsonOk } from "@/server/errors";
import { withAdminAuth } from "@/server/http";
import { listAuditLogs } from "@/server/audit-store";

export const Route = createFileRoute("/api/admin/logs")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAdminAuth(request, async () => {
          const url = new URL(request.url);
          const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
          const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
          const actorId = url.searchParams.get("actorId") || undefined;
          const action = url.searchParams.get("action") || undefined;
          const targetType = url.searchParams.get("targetType") || undefined;

          const result = listAuditLogs({
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100,
            offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
            ...(actorId ? { actorId } : {}),
            ...(action ? { action } : {}),
            ...(targetType ? { targetType } : {}),
          });

          return jsonOk(result);
        }),
    },
  },
});
