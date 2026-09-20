import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertCircle, Clock, Filter, History, RefreshCw, Search, Shield, X } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import type { AuditLogEntry } from "@/server/audit-store";

export const Route = createFileRoute("/admin/logs")({
  head: () => ({
    meta: [
      { title: "Audit Trail · MT5 Admin CRM" },
      { name: "description", content: "Append-only immutable audit trail of system events." },
    ],
  }),
  component: AdminLogsPage,
});

function AdminLogsPage() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionFilter, setActionFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (actionFilter !== "ALL") params.set("action", actionFilter);
      params.set("limit", "200");

      const res = await fetch(`/api/admin/logs?${params.toString()}`);
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: res.status === 403 ? "/dashboard" : "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load audit logs.");
      const data = await res.json();
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading audit records.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [actionFilter]);

  const filteredLogs = logs.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.actorEmail.toLowerCase().includes(q) ||
      l.action.toLowerCase().includes(q) ||
      l.targetType.toLowerCase().includes(q) ||
      (l.targetId && l.targetId.toLowerCase().includes(q)) ||
      (l.ipAddress && l.ipAddress.toLowerCase().includes(q))
    );
  });

  const actionBadge = (action: string) => {
    if (
      action.includes("LOGIN_FAILED") ||
      action.includes("SUSPEND") ||
      action.includes("DELETE")
    ) {
      return "bg-destructive/15 text-destructive border-destructive/25";
    }
    if (action.includes("LOGIN")) {
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25";
    }
    if (
      action.includes("SIGNUP") ||
      action.includes("APPROVE") ||
      action.includes("STATUS_CHANGE")
    ) {
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25";
    }
    if (action.includes("PERMISSIONS") || action.includes("LIMITS")) {
      return "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/25";
    }
    if (action.includes("BROKER") || action.includes("MONITOR")) {
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25";
    }
    return "bg-secondary text-muted-foreground border-border";
  };

  return (
    <AdminShell
      title="System Audit Trail"
      subtitle="Immutable append-only records of all security, access, and governance activities"
      right={
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            fetchLogs();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Filter and Search Bar */}
        <div className="panel p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3 py-1.5 sm:w-80">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search by actor email, action, target, IP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <Filter className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Action:</span>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="rounded-lg border border-input bg-secondary px-2.5 py-1 text-xs font-medium outline-none"
            >
              <option value="ALL">All Actions ({total})</option>
              <option value="USER_LOGIN">User Logins</option>
              <option value="USER_LOGIN_FAILED">Failed Logins</option>
              <option value="USER_SIGNUP">Signups / Registrations</option>
              <option value="USER_STATUS_CHANGE">Status Changes</option>
              <option value="USER_PERMISSIONS_UPDATE">Permission Updates</option>
              <option value="USER_LIMITS_UPDATE">Limit Updates</option>
              <option value="BROKER_CREATE">Broker Additions</option>
              <option value="MONITOR_ADD">Monitored Client Additions</option>
              <option value="MONITOR_REMOVE">Monitored Client Removals</option>
            </select>
          </div>
        </div>

        {/* Audit Log Table */}
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Details</th>
                  <th className="px-4 py-3 text-right">Client IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Loading audit records…
                    </td>
                  </tr>
                ) : filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No audit entries found.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((entry) => (
                    <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                      {/* Timestamp */}
                      <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {new Date(entry.timestamp).toLocaleString([], {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${actionBadge(
                            entry.action,
                          )}`}
                        >
                          {entry.action.replace(/_/g, " ")}
                        </span>
                      </td>

                      {/* Actor */}
                      <td className="px-4 py-3">
                        <p className="font-semibold text-foreground truncate max-w-[180px]">
                          {entry.actorEmail}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          Role: {entry.actorRole}
                        </p>
                      </td>

                      {/* Target */}
                      <td className="px-4 py-3">
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono font-medium text-foreground">
                          {entry.targetType}
                        </span>
                        {entry.targetId && (
                          <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[130px] mt-0.5">
                            {entry.targetId}
                          </p>
                        )}
                      </td>

                      {/* Details */}
                      <td className="px-4 py-3 text-[11px] text-muted-foreground max-w-xs">
                        {entry.details ? (
                          <span
                            className="font-mono text-[10px] truncate block"
                            title={JSON.stringify(entry.details)}
                          >
                            {JSON.stringify(entry.details).replace(/[{}"]/g, " ")}
                          </span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>

                      {/* IP */}
                      <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {entry.ipAddress || "local"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
