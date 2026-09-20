import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";

export const Route = createFileRoute("/admin/monitored")({
  head: () => ({
    meta: [
      { title: "Monitored Clients · MT5 Admin CRM" },
      {
        name: "description",
        content: "Oversight of client accounts actively watched across all operators.",
      },
    ],
  }),
  component: AdminMonitoredPage,
});

type EnrichedMonitored = {
  userId: string;
  brokerId: string;
  login: number;
  clientName?: string;
  createdAt: string;
  ownerName: string;
  ownerEmail: string;
  brokerName: string;
  brokerServer: string;
  brokerStatus: string;
};

function AdminMonitoredPage() {
  const navigate = useNavigate();
  const [monitored, setMonitored] = useState<EnrichedMonitored[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchMonitored = async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/monitored");
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: res.status === 403 ? "/dashboard" : "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load monitored clients.");
      const data = await res.json();
      setMonitored(data.monitored || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading monitored accounts.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMonitored();
  }, []);

  const filtered = monitored.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.login.toString().includes(q) ||
      (m.clientName && m.clientName.toLowerCase().includes(q)) ||
      m.ownerEmail.toLowerCase().includes(q) ||
      m.ownerName.toLowerCase().includes(q) ||
      m.brokerName.toLowerCase().includes(q) ||
      m.brokerServer.toLowerCase().includes(q)
    );
  });

  return (
    <AdminShell
      title="Monitored Client Accounts Oversight"
      subtitle="View all live MT5 client accounts being tracked across all operator accounts"
      right={
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            fetchMonitored();
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

        {/* Search & Counter bar */}
        <div className="panel p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3 py-1.5 sm:w-80">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search account login, client name, broker, operator…"
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

          <div className="text-xs text-muted-foreground">
            Watching <span className="font-semibold text-foreground">{monitored.length}</span>{" "}
            client accounts across platform
          </div>
        </div>

        {/* Monitored Accounts Table */}
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Client Account</th>
                  <th className="px-4 py-3">Broker Details</th>
                  <th className="px-4 py-3">Monitored By Operator</th>
                  <th className="px-4 py-3">Watch Since</th>
                  <th className="px-4 py-3 text-right">Client View</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      Loading monitored accounts…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      No monitored accounts found.
                    </td>
                  </tr>
                ) : (
                  filtered.map((item) => (
                    <tr
                      key={`${item.brokerId}-${item.login}`}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      {/* Account Login & Name */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="grid size-8 place-items-center rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
                            <Radar className="size-4" />
                          </div>
                          <div>
                            <p className="font-mono font-bold text-foreground">#{item.login}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {item.clientName || "Named Client Account"}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Broker Details */}
                      <td className="px-4 py-3">
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground flex items-center gap-1.5">
                            <Building2 className="size-3 text-muted-foreground" />
                            {item.brokerName}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {item.brokerServer}
                          </p>
                        </div>
                      </td>

                      {/* Operator Info */}
                      <td className="px-4 py-3">
                        <Link
                          to="/admin/users/$id"
                          params={{ id: item.userId }}
                          className="hover:underline"
                        >
                          <p className="font-semibold text-foreground flex items-center gap-1">
                            <User className="size-3 text-muted-foreground" />
                            {item.ownerName}
                          </p>
                          <p className="text-[11px] text-muted-foreground font-mono">
                            {item.ownerEmail}
                          </p>
                        </Link>
                      </td>

                      {/* Monitored Date */}
                      <td className="px-4 py-3 text-[11px] text-muted-foreground">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>

                      {/* Client View Link */}
                      <td className="px-4 py-3 text-right">
                        <Link
                          to="/client/$login"
                          params={{ login: item.login.toString() }}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-secondary/80 transition-colors"
                        >
                          <span>Live Stats</span>
                        </Link>
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
