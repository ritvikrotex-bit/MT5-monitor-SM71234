import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, ChevronRight, Radar, Bell, TrendingUp, X } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { NotificationCard } from "@/components/mt5/cards";
import { DataFreshness, Metric, ReadOnlyBadge, StatusDot } from "@/components/mt5/primitives";
import { store, useAppState } from "@/lib/app-store";
import { notificationMeta, toTradeNotification, type TradeNotification } from "@/lib/mt5-data";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

type LiveClient = {
  brokerId: string;
  login: number;
  name: string;
  balance?: number;
  equity?: number;
  floatingProfit?: number;
  currency?: string;
  positions: unknown[];
  unavailable?: boolean;
};

type ApiBroker = {
  id: string;
  name: string;
  server: string;
  status: string;
  managerLogin: string;
};

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard · MT5 Client Live Monitor" },
      {
        name: "description",
        content:
          "Operations dashboard: connected brokers, monitored clients, active positions and live client trading activity.",
      },
      { property: "og:title", content: "Dashboard · MT5 Client Live Monitor" },
      {
        property: "og:description",
        content: "Live overview of monitored MT5 clients, brokers and trading alerts.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const s = useAppState();
  const [liveClients, setLiveClients] = useState<LiveClient[]>([]);
  const [liveAlerts, setLiveAlerts] = useState<TradeNotification[]>([]);
  const [lastRefreshed, setLastRefreshed] = useState<string>("just now");

  const loadData = async () => {
    try {
      const [brokersRes, monitoredRes, notifRes] = await Promise.all([
        fetch("/api/brokers"),
        fetch("/api/monitored"),
        fetch("/api/notifications"),
      ]);

      if (brokersRes.ok) {
        const data = await brokersRes.json().catch(() => ({}));
        if (Array.isArray(data.brokers)) {
          store.setBrokers(
            (data.brokers as ApiBroker[]).map((b) => ({
              id: b.id,
              name: b.name,
              server: b.server,
              status: b.status === "CONNECTED" ? "connected" : "disconnected",
              managerLogin: b.managerLogin,
              lastUpdate: "now",
            })),
          );
        }
      }

      if (monitoredRes.ok) {
        const data = await monitoredRes.json().catch(() => ({}));
        const clients = (data.clients || []) as LiveClient[];
        setLiveClients(clients);
        store.setMonitored(clients.map((c) => String(c.login)));
      }

      if (notifRes.ok) {
        const data = await notifRes.json().catch(() => ({}));
        const alerts = (data.alerts || []).map(toTradeNotification) as TradeNotification[];
        setLiveAlerts(alerts);
        store.setNotifications(alerts);
      }

      setLastRefreshed(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("[Dashboard] Error loading live data:", err);
    }
  };

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => {
      void loadData();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeBroker = s.brokers.find((b) => b.id === s.activeBrokerId);
  const connectedCount = s.brokers.filter((b) => b.status === "connected").length;

  // Filter accounts and alerts by activeBrokerId if one is chosen
  const filteredClients = s.activeBrokerId
    ? liveClients.filter((c) => c.brokerId === s.activeBrokerId)
    : liveClients;
  const filteredPositionsCount = filteredClients.reduce(
    (n, c) => n + (Array.isArray(c.positions) ? c.positions.length : 0),
    0,
  );
  const totalClientsCount = liveClients.length;
  const totalPositionsCount = liveClients.reduce(
    (n, c) => n + (Array.isArray(c.positions) ? c.positions.length : 0),
    0,
  );

  const filteredAlerts = s.activeBrokerId
    ? liveAlerts.filter((a) => a.brokerId === s.activeBrokerId)
    : liveAlerts;
  const todaysAlertsCount = filteredAlerts.filter((n) => n.day === "today").length;
  const totalTodaysAlertsCount = liveAlerts.filter((n) => n.day === "today").length;
  const unreadAlertsCount = filteredAlerts.filter((n) => !s.readIds.includes(n.id)).length;

  // Display top 3 alerts
  const displayAlerts = filteredAlerts.slice(0, 3);

  return (
    <AppShell
      title={`Good morning, ${s.userName}`}
      subtitle={<DataFreshness ok={s.connectionOk} time={lastRefreshed} />}
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      {!s.pushPromptSeen && <PushPrompt />}

      <section className="mt-4 grid grid-cols-2 gap-3">
        <Metric
          label="Connected brokers"
          value={`${connectedCount}`}
          sub={`${s.brokers.length} saved`}
        />
        <div className="panel p-3">
          <p className="label-xs">Dashboard focus</p>
          <p className="mt-1 truncate text-lg font-semibold">
            {activeBroker ? activeBroker.name : "All Brokers"}
          </p>
          {activeBroker ? (
            <StatusDot status={activeBroker.status} className="mt-0.5" />
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">{connectedCount} connected</p>
          )}
        </div>
      </section>

      <section className="mt-3 grid grid-cols-3 gap-3">
        <Metric
          label="Monitored"
          value={`${filteredClients.length}`}
          sub={
            activeBroker ? `${totalClientsCount} total across all` : `${totalClientsCount} active`
          }
        />
        <Metric
          label="Positions"
          value={`${filteredPositionsCount}`}
          sub={
            activeBroker ? `${totalPositionsCount} total across all` : `${totalPositionsCount} open`
          }
        />
        <Metric
          label="Alerts today"
          value={`${todaysAlertsCount}`}
          {...(activeBroker && totalTodaysAlertsCount !== todaysAlertsCount
            ? { sub: `${totalTodaysAlertsCount} total today` }
            : {})}
        />
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Live client activity</h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="live-dot size-1.5 rounded-full bg-positive" /> Streaming
          </span>
        </div>
        {displayAlerts.length === 0 ? (
          <div className="panel mt-3 p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No live trade activity recorded yet today. Active accounts are monitored continuously
              in real-time.
            </p>
          </div>
        ) : (
          <div className="panel mt-3 divide-y divide-border">
            {displayAlerts.map((n) => {
              const tone = notificationMeta[n.type]?.tone || "neutral";
              return (
                <Link
                  key={n.id}
                  to="/notifications/$id"
                  params={{ id: n.id }}
                  className="flex items-center gap-3 p-3.5 transition-colors hover:bg-accent/40"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      tone === "positive" && "bg-positive",
                      tone === "warning" && "bg-warning",
                      tone === "negative" && "bg-negative",
                      tone === "neutral" && "bg-muted-foreground",
                    )}
                    aria-hidden
                  />
                  <span className="num shrink-0 text-xs text-muted-foreground">{n.time}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{n.clientName}</span>
                    <span className="num block truncate text-xs text-muted-foreground">
                      {notificationMeta[n.type]?.label || n.type} · {n.symbol} {n.side} ·{" "}
                      {n.lots.toFixed(2)} lots
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <QuickLink
          to="/brokers"
          icon={Building2}
          title="Brokers"
          sub={`${s.brokers.length} saved`}
        />
        <QuickLink
          to="/monitored"
          icon={Radar}
          title="Monitored clients"
          sub={`${filteredClients.length} active`}
        />
        <QuickLink
          to="/notifications"
          icon={Bell}
          title="Notifications"
          sub={`${unreadAlertsCount} unread`}
        />
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Recent alerts</h2>
        {displayAlerts.length === 0 ? (
          <div className="panel mt-3 p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No recent alerts to display for the current filter.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {displayAlerts.map((n) => (
              <NotificationCard key={n.id} n={n} unread={!s.readIds.includes(n.id)} />
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground sm:hidden">
        <TrendingUp className="size-3.5" /> Observe · Monitor · Notify
      </p>
    </AppShell>
  );
}

function QuickLink({
  to,
  icon: Icon,
  title,
  sub,
}: {
  to: "/brokers" | "/monitored" | "/notifications";
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="panel flex items-center gap-3 p-4 transition-colors hover:bg-accent/40"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

function PushPrompt() {
  return (
    <div className="panel enter relative mt-2 border-primary/30 p-4">
      <button
        onClick={() => store.dismissPushPrompt()}
        aria-label="Dismiss"
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          <Bell className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Enable notifications</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Never miss an important client trade. Get alerts when monitored clients open, close or
            modify positions.
          </p>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => store.setPush(true)}
          className="flex-1 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground"
        >
          Enable notifications
        </button>
        <button
          onClick={() => store.dismissPushPrompt()}
          className="rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-medium text-muted-foreground"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
