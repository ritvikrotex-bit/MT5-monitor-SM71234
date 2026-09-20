import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";

export const Route = createFileRoute("/admin/brokers")({
  head: () => ({
    meta: [
      { title: "Broker Oversight · MT5 Admin CRM" },
      { name: "description", content: "Read-only MT5 broker connection governance and oversight." },
    ],
  }),
  component: AdminBrokersPage,
});

type EnrichedBroker = {
  id: string;
  name: string;
  server: string;
  managerLogin: string;
  status: string;
  statusMessage: string;
  createdAt: string;
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  ownerRole: string;
  ownerStatus: string;
};

function AdminBrokersPage() {
  const navigate = useNavigate();
  const [brokers, setBrokers] = useState<EnrichedBroker[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [error, setError] = useState<string | null>(null);

  const fetchBrokers = async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/brokers");
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load broker list.");
      const data = await res.json();
      setBrokers(data.brokers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading brokers.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBrokers();
  }, []);

  const filteredBrokers = brokers.filter((b) => {
    const matchesSearch =
      !search ||
      b.name.toLowerCase().includes(search.toLowerCase()) ||
      b.server.toLowerCase().includes(search.toLowerCase()) ||
      b.managerLogin.includes(search) ||
      b.ownerEmail.toLowerCase().includes(search.toLowerCase()) ||
      b.ownerName.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === "ALL" || b.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <AdminShell
      title="Broker Governance & Oversight"
      subtitle="Read-only platform oversight of all configured MT5 broker connections"
      right={
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            fetchBrokers();
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
        {/* Safety Boundary Notice */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2 font-bold text-sm">
            <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
            <span>Strict Read-Only Broker Governance</span>
          </div>
          <p className="mt-1 opacity-90 leading-relaxed">
            The administrator panel provides governance and oversight of MT5 connections without
            exposing broker passwords or granting execution capabilities. No order placement,
            balance alterations, or position closing functions exist in this panel.
          </p>
        </div>

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
              placeholder="Search broker, server, login, operator…"
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

          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 text-xs font-medium">
            {["ALL", "CONNECTED", "DISCONNECTED", "ERROR"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1 transition-colors capitalize ${
                  statusFilter === s
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Brokers Table */}
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Broker Details</th>
                  <th className="px-4 py-3">MT5 Server</th>
                  <th className="px-4 py-3">Manager Login</th>
                  <th className="px-4 py-3">Operator / Owner</th>
                  <th className="px-4 py-3">Connection Status</th>
                  <th className="px-4 py-3">Last Health Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Loading broker oversight data…
                    </td>
                  </tr>
                ) : filteredBrokers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No brokers match the filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredBrokers.map((broker) => (
                    <tr key={broker.id} className="hover:bg-muted/30 transition-colors">
                      {/* Name & ID */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="grid size-8 place-items-center rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
                            <Building2 className="size-4" />
                          </div>
                          <div>
                            <p className="font-semibold text-foreground">{broker.name}</p>
                            <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[140px]">
                              {broker.id}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Server */}
                      <td className="px-4 py-3 font-mono font-medium text-foreground">
                        {broker.server}
                      </td>

                      {/* Manager Login */}
                      <td className="px-4 py-3 font-mono text-muted-foreground">
                        {broker.managerLogin}
                      </td>

                      {/* Owner Operator */}
                      <td className="px-4 py-3">
                        <Link
                          to="/admin/users/$id"
                          params={{ id: broker.ownerUserId }}
                          className="hover:underline"
                        >
                          <p className="font-semibold text-foreground">{broker.ownerName}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">
                            {broker.ownerEmail}
                          </p>
                        </Link>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            broker.status === "CONNECTED"
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              : broker.status === "ERROR"
                                ? "bg-destructive/15 text-destructive"
                                : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              broker.status === "CONNECTED"
                                ? "bg-emerald-500"
                                : broker.status === "ERROR"
                                  ? "bg-destructive"
                                  : "bg-muted-foreground"
                            }`}
                          />
                          {broker.status}
                        </span>
                      </td>

                      {/* Status message */}
                      <td className="px-4 py-3 text-[11px] text-muted-foreground">
                        <p className="truncate max-w-[200px]" title={broker.statusMessage}>
                          {broker.statusMessage || "Status healthy"}
                        </p>
                        <p className="text-[10px] opacity-75">
                          Added {new Date(broker.createdAt).toLocaleDateString()}
                        </p>
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
