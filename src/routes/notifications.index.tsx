import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BellOff, CheckCheck } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { NotificationCard } from "@/components/mt5/cards";
import { EmptyState, ReadOnlyBadge } from "@/components/mt5/primitives";
import { store, useAppState } from "@/lib/app-store";
import { notificationMeta, type NotificationType, type TradeNotification } from "@/lib/mt5-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/notifications/")({
  head: () => ({
    meta: [
      { title: "Notifications · MT5 Client Live Monitor" },
      {
        name: "description",
        content:
          "Real-time alert feed for monitored MT5 clients: new positions, closures and stop-loss or take-profit modifications.",
      },
      { property: "og:title", content: "Notifications · MT5 Client Live Monitor" },
      {
        property: "og:description",
        content: "Live trading activity alerts for your monitored MT5 client accounts.",
      },
    ],
  }),
  component: NotificationsPage,
});

const filters: { key: "all" | NotificationType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new_position", label: "New" },
  { key: "position_closed", label: "Closed" },
  { key: "sl_modified", label: "SL" },
  { key: "tp_modified", label: "TP" },
  { key: "position_modified", label: "Modified" },
];

function NotificationsPage() {
  const s = useAppState();
  const [filter, setFilter] = useState<"all" | NotificationType>("all");
  const [live, setLive] = useState<TradeNotification[]>([]);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/notifications");
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(payload.message || "Unable to load notification history.");
        setLive((payload.alerts || []).map(toNotification));
        setTelegramConfigured(Boolean(payload.telegramConfigured));
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to load notification history.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const list = useMemo(
    () => live.filter((n) => filter === "all" || n.type === filter),
    [live, filter],
  );
  const today = list.filter((n) => n.day === "today");
  const yesterday = list.filter((n) => n.day === "yesterday");
  const unread = live.filter((n) => !s.readIds.includes(n.id)).length;

  return (
    <AppShell
      title="Notifications"
      subtitle={unread > 0 ? `${unread} unread alerts` : "All caught up"}
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="-mx-4 flex flex-1 gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-primary/45 bg-primary/15 text-primary"
                  : "border-border bg-secondary text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => store.markAllRead()}
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <CheckCheck className="size-3.5" /> Mark all read
        </button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Telegram delivery:{" "}
        {telegramConfigured
          ? "configured"
          : "not configured — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to the server environment."}
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      {list.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={BellOff}
            title="No notifications"
            description="Alerts for this filter will appear here as soon as a monitored client trades."
            action={
              <Link
                to="/monitored"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
              >
                View monitored clients
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <Group title="Today" items={today} readIds={s.readIds} />
          <Group title="Yesterday" items={yesterday} readIds={s.readIds} />
        </>
      )}
    </AppShell>
  );
}

function toNotification(alert: {
  id: string;
  type: NotificationType;
  clientLogin: string;
  clientName: string;
  brokerId: string;
  position: {
    symbol: string;
    direction: "BUY" | "SELL";
    volume: number;
    openPrice: number;
    profit: number;
    sl?: number | null;
    tp?: number | null;
    positionId: string;
  };
  from?: number | null;
  to?: number | null;
  createdAt: string;
}): TradeNotification {
  const at = new Date(alert.createdAt);
  const minutesAgo = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  return {
    id: alert.id,
    type: alert.type,
    clientLogin: alert.clientLogin,
    clientName: alert.clientName,
    brokerId: alert.brokerId,
    symbol: alert.position.symbol,
    side: alert.position.direction,
    lots: alert.position.volume,
    price: alert.position.openPrice,
    tp: alert.position.tp ?? null,
    sl: alert.position.sl ?? null,
    ...(alert.from != null ? { from: alert.from } : {}),
    ...(alert.to != null ? { to: alert.to } : {}),
    pl: alert.position.profit,
    positionId: alert.position.positionId,
    minutesAgo,
    time: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    day: minutesAgo < 24 * 60 ? "today" : "yesterday",
  };
}

function Group({
  title,
  items,
  readIds,
}: {
  title: string;
  items: ReturnType<typeof useAppState>["notifications"];
  readIds: string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="label-xs">{title}</h2>
      <div className="mt-3 space-y-3">
        {items.map((n) => (
          <NotificationCard key={n.id} n={n} unread={!readIds.includes(n.id)} />
        ))}
      </div>
    </section>
  );
}

export { notificationMeta };
