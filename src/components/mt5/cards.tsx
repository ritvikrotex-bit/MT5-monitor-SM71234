import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { brokerName } from "@/lib/app-store";
import { ago, notificationMeta, price, signedMoney, type TradeNotification } from "@/lib/mt5-data";

const toneClass = {
  positive: "border-positive/35 bg-positive/12 text-positive",
  negative: "border-negative/35 bg-negative/12 text-negative",
  warning: "border-warning/35 bg-warning/12 text-warning",
  neutral: "border-border bg-secondary text-muted-foreground",
};

export function NotificationCard({
  n,
  unread,
  compact,
}: {
  n: TradeNotification;
  unread?: boolean;
  compact?: boolean;
}) {
  const meta = notificationMeta[n.type];
  return (
    <Link
      to="/notifications/$id"
      params={{ id: n.id }}
      className={cn(
        "panel enter block p-4 transition-colors hover:bg-accent/40",
        unread && "border-primary/30",
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase",
              toneClass[meta.tone],
            )}
          >
            {meta.label}
          </span>
          <h3 className="mt-2 truncate text-sm font-semibold">{n.clientName}</h3>
          <p className="num truncate text-xs text-muted-foreground">
            {n.brokerName ?? brokerName(n.brokerId)} · {n.clientLogin}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="num text-xs text-muted-foreground">{n.time}</p>
          <p className="text-[11px] text-muted-foreground">{ago(n.minutesAgo)}</p>
          {unread && <span className="mt-1 ml-auto block size-2 rounded-full bg-primary" />}
        </div>
      </div>

      {!compact && (
        <div className="num mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-sm">
          <span className="font-semibold">{n.symbol}</span>
          <span className={n.side === "BUY" ? "text-positive" : "text-negative"}>{n.side}</span>
          <span className="text-muted-foreground">{n.lots.toFixed(2)} lots</span>
          {n.price !== undefined && (
            <span className="text-muted-foreground">@ {price(n.price)}</span>
          )}
          {n.from !== undefined && n.to !== undefined && (
            <span className="text-warning">
              {price(n.from)} → {price(n.to)}
            </span>
          )}
          {n.pl !== undefined && (
            <span className={n.pl >= 0 ? "text-positive" : "text-negative"}>
              P/L {signedMoney(n.pl)}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
