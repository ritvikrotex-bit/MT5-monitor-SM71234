import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, BellOff, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { EmptyState, ReadOnlyBadge } from "@/components/mt5/primitives";
import { brokerName, store, useAppState } from "@/lib/app-store";
import {
  ago,
  notificationMeta,
  price,
  signedMoney,
  toTradeNotification,
  type TradeNotification,
} from "@/lib/mt5-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/notifications/$id")({
  head: () => ({
    meta: [{ title: "Alert detail · MT5 Monitor" }, { name: "robots", content: "noindex" }],
  }),
  component: NotificationDetail,
});

function AlertNotFound() {
  return (
    <AppShell title="Alert not found">
      <div className="mt-6">
        <EmptyState
          icon={BellOff}
          title="Alert unavailable"
          description="This notification no longer exists or has expired from the feed."
          action={
            <Link
              to="/notifications"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Back to notifications
            </Link>
          }
        />
      </div>
    </AppShell>
  );
}

function NotificationDetail() {
  const { id } = Route.useParams();
  const s = useAppState();
  const cached = s.notifications.find((x) => x.id === id);
  // undefined = still loading, null = not in the feed
  const [fetched, setFetched] = useState<TradeNotification | null | undefined>(undefined);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetch("/api/notifications")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const alerts = ((data?.alerts ?? []) as Parameters<typeof toTradeNotification>[0][]).map(
          toTradeNotification,
        );
        setFetched(alerts.find((x) => x.id === id) ?? null);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, cached]);

  useEffect(() => {
    store.markRead(id);
  }, [id]);

  const n = cached ?? fetched;
  if (n === undefined) {
    return (
      <AppShell title="Alert">
        <p className="mt-6 text-sm text-muted-foreground">Loading alert…</p>
      </AppShell>
    );
  }
  if (n === null) return <AlertNotFound />;

  const meta = notificationMeta[n.type];
  const monitored = s.monitored.includes(n.clientLogin);

  return (
    <AppShell
      title={meta.label}
      subtitle={`${n.time} · ${ago(n.minutesAgo)}`}
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <Link
        to="/notifications"
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All notifications
      </Link>

      <section className="panel enter mt-3 p-4">
        <span
          className={cn(
            "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase",
            meta.tone === "positive" && "border-positive/35 bg-positive/12 text-positive",
            meta.tone === "negative" && "border-negative/35 bg-negative/12 text-negative",
            meta.tone === "warning" && "border-warning/35 bg-warning/12 text-warning",
            meta.tone === "neutral" && "border-border bg-secondary text-muted-foreground",
          )}
        >
          {meta.label}
        </span>
        <h2 className="num mt-3 text-xl font-semibold">
          {n.symbol}{" "}
          <span className={n.side === "BUY" ? "text-positive" : "text-negative"}>{n.side}</span>
        </h2>
        <p className="num mt-1 text-sm text-muted-foreground">{n.lots.toFixed(2)} lots</p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-sm">
          <Item label="Client" value={n.clientName} />
          <Item label="Login" value={n.clientLogin} />
          <Item label="Broker" value={n.brokerName ?? brokerName(n.brokerId)} />
          <Item label="Position ID" value={n.positionId ?? "—"} />
          {n.price !== undefined && <Item label="Price" value={price(n.price)} />}
          {n.sl !== undefined && n.sl !== null && <Item label="Stop loss" value={price(n.sl)} />}
          {n.tp !== undefined && n.tp !== null && <Item label="Take profit" value={price(n.tp)} />}
          {n.from !== undefined && n.to !== undefined && (
            <Item label="Change" value={`${price(n.from)} → ${price(n.to)}`} />
          )}
          {n.pl !== undefined && <Item label="Realized P/L" value={signedMoney(n.pl)} />}
          <Item label="Time" value={`${n.time} · ${n.day}`} />
        </dl>
      </section>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Link
          to="/client/$login"
          params={{ login: n.clientLogin }}
          className="rounded-lg bg-primary py-3 text-center text-sm font-semibold text-primary-foreground"
        >
          View client account
        </Link>
        <button
          onClick={() => store.toggleMonitor(n.clientLogin)}
          className="rounded-lg border border-border bg-secondary py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {monitored ? "Stop monitoring client" : "Monitor this client"}
        </button>
      </div>

      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Informational alert — no action can be taken on the
        trade
      </p>
    </AppShell>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="label-xs">{label}</dt>
      <dd className="num truncate text-sm font-medium">{value}</dd>
    </div>
  );
}
