import { Bell, BellRing, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/lib/mt5-data";

const statusCopy: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  error: "Connection issue",
};

const statusTone: Record<ConnectionStatus, string> = {
  connected: "bg-positive",
  connecting: "bg-warning",
  disconnected: "bg-muted-foreground",
  error: "bg-negative",
};

export function StatusDot({
  status,
  label = true,
  className,
}: {
  status: ConnectionStatus;
  label?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          statusTone[status],
          status === "connected" && "live-dot",
        )}
      />
      {label && (
        <span
          className={cn(
            status === "connected" && "text-positive",
            status === "connecting" && "text-warning",
            status === "error" && "text-negative",
            status === "disconnected" && "text-muted-foreground",
          )}
        >
          {statusCopy[status]}
        </span>
      )}
    </span>
  );
}

export function BellToggle({
  active,
  onClick,
  size = "md",
  label,
}: {
  active: boolean;
  onClick: () => void;
  size?: "md" | "lg";
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? `Stop monitoring ${label}` : `Monitor ${label}`}
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full border transition-all active:scale-95",
        size === "lg" ? "size-12" : "size-10",
        active
          ? "border-primary/45 bg-primary/15 text-primary"
          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      {active ? (
        <BellRing className={cn(size === "lg" ? "size-5" : "size-4", "bell-ring")} />
      ) : (
        <Bell className={size === "lg" ? "size-5" : "size-4"} />
      )}
      {active && (
        <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-primary" />
      )}
    </button>
  );
}

export function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/70 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase",
        className,
      )}
    >
      <ShieldCheck className="size-3" /> Read-only monitoring
    </span>
  );
}

export function Metric({
  label,
  value,
  tone = "default",
  sub,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  sub?: string;
}) {
  return (
    <div className="panel p-3">
      <p className="label-xs">{label}</p>
      <p
        className={cn(
          "num mt-1 text-lg font-semibold",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel enter flex flex-col items-center px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-full border border-border bg-secondary">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="panel space-y-3 p-4">
          <div className="h-3 w-1/3 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}

export function DataFreshness({
  ok,
  time,
  seconds = 2,
}: {
  ok: boolean;
  time: string;
  seconds?: number;
}) {
  if (!ok)
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-warning">
        <span className="size-1.5 rounded-full bg-warning" /> Data may be stale · last updated{" "}
        {time}
      </p>
    );
  return (
    <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="live-dot size-1.5 rounded-full bg-positive" /> Live · updated {seconds}s ago
    </p>
  );
}
