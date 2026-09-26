import { createFileRoute } from "@tanstack/react-router";
import { requireCopierPermission } from "@/server/copier-access";
import { copierEvents, copierStatus, type CopierLinkStatus } from "@/server/copier-client";
import { listCopierAccounts, listCopierLinks, listMasterBrokers } from "@/server/copier-store";
import { jsonOk } from "@/server/errors";
import { withAuth } from "@/server/http";

/**
 * Everything the copier page needs in one read: the user's own accounts and
 * links, plus live status and recent events from the copier service.
 *
 * The service is queried without letting an outage fail the whole request —
 * the configuration is still worth showing when the copier is stopped, and the
 * page reports that separately.
 */
export const Route = createFileRoute("/api/copier")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withAuth(request, async (user) => {
          requireCopierPermission(user);
          const accounts = listCopierAccounts(user.id);
          const links = listCopierLinks(user.id);
          const brokers = listMasterBrokers(user.id);
          const mine = new Set(links.map((l) => l.id));

          let running = false;
          let serviceError: string | null = null;
          let statuses: Record<string, CopierLinkStatus> = {};
          let events: unknown[] = [];
          try {
            const status = await copierStatus();
            running = status.running;
            statuses = Object.fromEntries(
              status.links.filter((l) => mine.has(l.id)).map((l) => [l.id, l]),
            );
            const recent = await copierEvents(100);
            events = recent.events.filter((e) => mine.has(e.linkId));
          } catch (err) {
            serviceError =
              err instanceof Error ? err.message : "The copier service is unreachable.";
          }

          return jsonOk({
            accounts,
            brokers,
            links: links.map((link) => ({ ...link, status: statuses[link.id] ?? null })),
            events,
            service: { running, error: serviceError },
          });
        }),
    },
  },
});
