import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  History,
  Lock,
  Radar,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useApp } from "@/lib/app-store";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Admin CRM · MT5 Client Live Monitor" },
      {
        name: "description",
        content: "Central CRM, User Management and Governance for MT5 Client Live Monitor.",
      },
    ],
  }),
  component: AdminDashboardPage,
});

type StatsData = {
  users: {
    total: number;
    active: number;
    pending: number;
    suspended: number;
  };
  brokers: {
    total: number;
    connected: number;
    disconnected: number;
  };
  monitored: {
    total: number;
  };
  recentActivity: Array<{
    id: string;
    timestamp: string;
    actorEmail: string;
    actorRole: string;
    action: string;
    targetType: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }>;
};

function AdminDashboardPage() {
  const navigate = useNavigate();
  const currentUser = useApp((s) => s.user);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/stats");
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load admin statistics.");
      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading dashboard.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 20000);
    return () => clearInterval(interval);
  }, []);

  const formatAction = (action: string) => {
    return action.replace(/_/g, " ");
  };

  const actionBadge = (action: string) => {
    if (action.includes("LOGIN")) {
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20";
    }
    if (action.includes("SIGNUP") || action.includes("APPROVE")) {
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
    }
    if (action.includes("SUSPEND") || action.includes("DELETE") || action.includes("FAILED")) {
      return "bg-destructive/15 text-destructive border-destructive/20";
    }
    if (action.includes("BROKER") || action.includes("MONITOR")) {
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20";
    }
    return "bg-secondary text-muted-foreground border-border";
  };

  return (
    <AdminShell
      title="Admin CRM & Governance"
      subtitle="Overview of user access, approvals, brokers, and live activity"
      right={
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            fetchStats();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      }
    >
      <div className="space-y-6">
        {/* Pending Approvals Urgent Alert Banner */}
        {stats && stats.users.pending > 0 && (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400">
                <Clock className="size-5" />
              </div>
              <div>
                <p className="font-semibold text-sm">
                  {stats.users.pending} Account{stats.users.pending === 1 ? "" : "s"} Awaiting
                  Approval
                </p>
                <p className="text-xs opacity-90">
                  New users have registered and require administrator authorization before logging
                  in.
                </p>
              </div>
            </div>
            <Link
              to="/admin/approvals"
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-amber-700 transition-colors"
            >
              <span>Review Requests</span>
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        )}

        {/* Read-Only Safety Protocol Banner */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
              <ShieldCheck className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">Strict Read-Only Operational Safety Active</p>
                <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  ENFORCED
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                The Admin panel functions strictly as a CRM and governance layer. Order placement,
                trade modification, stop-loss adjustment, and balance execution endpoints are
                mathematically disconnected.
              </p>
            </div>
          </div>
        </div>

        {/* High-Level KPI Metric Cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Total Users */}
          <div className="panel p-5">
            <div className="flex items-center justify-between">
              <span className="label-xs text-muted-foreground">Total Users</span>
              <div className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
                <Users className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight">
                {loading ? "…" : (stats?.users.total ?? 0)}
              </span>
              <span className="text-xs text-muted-foreground">registered</span>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {stats?.users.active ?? 0} active
              </span>
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {stats?.users.pending ?? 0} pending
              </span>
              <span className="flex items-center gap-1 text-destructive">
                <span className="size-1.5 rounded-full bg-destructive" />
                {stats?.users.suspended ?? 0} suspended
              </span>
            </div>
          </div>

          {/* Pending Approvals */}
          <Link
            to="/admin/approvals"
            className="panel p-5 hover:border-amber-500/40 transition-colors group cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="label-xs text-muted-foreground">Pending Approvals</span>
              <div className="grid size-8 place-items-center rounded-lg bg-amber-500/15 text-amber-500">
                <Clock className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
                {loading ? "…" : (stats?.users.pending ?? 0)}
              </span>
              <span className="text-xs text-muted-foreground">in queue</span>
            </div>
            <p className="mt-3 flex items-center gap-1 text-xs text-primary group-hover:underline">
              <span>Manage approval queue</span>
              <ArrowRight className="size-3" />
            </p>
          </Link>

          {/* Connected Brokers */}
          <Link
            to="/admin/brokers"
            className="panel p-5 hover:border-primary/40 transition-colors group cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="label-xs text-muted-foreground">MT5 Brokers</span>
              <div className="grid size-8 place-items-center rounded-lg bg-blue-500/10 text-blue-500">
                <Building2 className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight">
                {loading ? "…" : (stats?.brokers.total ?? 0)}
              </span>
              <span className="text-xs text-muted-foreground">configured</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="text-emerald-600 dark:text-emerald-400">
                {stats?.brokers.connected ?? 0} connected
              </span>
              <span className="flex items-center gap-1 text-primary group-hover:underline">
                <span>View all</span>
                <ArrowRight className="size-3" />
              </span>
            </div>
          </Link>

          {/* Monitored Accounts */}
          <Link
            to="/admin/monitored"
            className="panel p-5 hover:border-primary/40 transition-colors group cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="label-xs text-muted-foreground">Monitored Clients</span>
              <div className="grid size-8 place-items-center rounded-lg bg-purple-500/10 text-purple-500">
                <Radar className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight">
                {loading ? "…" : (stats?.monitored.total ?? 0)}
              </span>
              <span className="text-xs text-muted-foreground">live accounts</span>
            </div>
            <p className="mt-3 flex items-center gap-1 text-xs text-primary group-hover:underline">
              <span>View monitored list</span>
              <ArrowRight className="size-3" />
            </p>
          </Link>
        </div>

        {/* Quick Governance Actions Grid */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Link
            to="/admin/users"
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:border-primary/50 transition-colors"
          >
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Users className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">User Directory</p>
              <p className="text-xs text-muted-foreground">Manage permissions, limits & status</p>
            </div>
          </Link>

          <Link
            to="/admin/approvals"
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:border-amber-500/50 transition-colors"
          >
            <div className="grid size-10 place-items-center rounded-lg bg-amber-500/15 text-amber-500">
              <UserCheck className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">Approval Queue</p>
              <p className="text-xs text-muted-foreground">Review and activate new registrations</p>
            </div>
          </Link>

          <Link
            to="/admin/logs"
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:border-blue-500/50 transition-colors"
          >
            <div className="grid size-10 place-items-center rounded-lg bg-blue-500/10 text-blue-500">
              <History className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">System Audit Trail</p>
              <p className="text-xs text-muted-foreground">
                Inspect security and operational events
              </p>
            </div>
          </Link>
        </div>

        {/* Recent Audit & Activity Feed */}
        <div className="panel p-5">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div>
              <h2 className="text-sm font-bold">Recent System Activity</h2>
              <p className="text-xs text-muted-foreground">Append-only audit trail entries</p>
            </div>
            <Link
              to="/admin/logs"
              className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <span>Full Audit Trail</span>
              <ArrowRight className="size-3" />
            </Link>
          </div>

          <div className="mt-4 divide-y divide-border/60">
            {loading && (
              <div className="py-8 text-center text-xs text-muted-foreground">
                Loading recent activity…
              </div>
            )}

            {!loading && (!stats?.recentActivity || stats.recentActivity.length === 0) && (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No recorded activity yet.
              </div>
            )}

            {stats?.recentActivity?.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-4 py-3 text-xs">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`rounded-md border px-2 py-0.5 text-[10px] font-bold shrink-0 uppercase tracking-wider ${actionBadge(
                      entry.action,
                    )}`}
                  >
                    {formatAction(entry.action)}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">
                      {entry.actorEmail}
                      <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                        ({entry.actorRole})
                      </span>
                    </p>
                    {entry.details && (
                      <p className="text-[11px] text-muted-foreground truncate">
                        {JSON.stringify(entry.details).replace(/[{}"]/g, " ")}
                      </p>
                    )}
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground shrink-0 font-mono">
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
