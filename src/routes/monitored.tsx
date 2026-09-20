import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Radar, RefreshCw, Search as SearchIcon } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { EmptyState, ReadOnlyBadge } from "@/components/mt5/primitives";
import { money, signedMoney } from "@/lib/mt5-data";

type Item = {
  brokerId: string;
  login: number;
  name: string;
  balance?: number;
  equity?: number;
  floatingProfit?: number;
  currency?: string;
  positions: unknown[];
  unavailable?: boolean;
  message?: string;
};
type Payload = { clients: Item[]; refreshedAt: string; refreshAfterSeconds: number };
export const Route = createFileRoute("/monitored")({ component: MonitoredPage });

function MonitoredPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/monitored");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Unable to refresh monitored accounts.");
      setData(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to refresh monitored accounts.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const clients = data?.clients || [];
  return (
    <AppShell
      title="Monitored clients"
      subtitle={
        data
          ? `Refreshed ${new Date(data.refreshedAt).toLocaleTimeString()} · next refresh in ${data.refreshAfterSeconds}s`
          : "Loading live watchlist"
      }
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <div className="mt-4 flex justify-end">
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-2 text-xs font-medium"
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh now
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {clients.length === 0 && !loading ? (
        <div className="mt-6">
          <EmptyState
            icon={Radar}
            title="No clients monitored yet"
            description="Search for a live account and choose Monitor client. This watchlist refreshes safely every 15 seconds."
            action={
              <Link
                to="/search"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
              >
                <SearchIcon className="size-4" /> Search clients
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {clients.map((client) => (
            <article key={`${client.brokerId}-${client.login}`} className="panel p-4">
              <div className="flex justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{client.name}</h2>
                  <p className="num text-xs text-muted-foreground">
                    Login {client.login} · {client.positions.length} open positions
                  </p>
                </div>
                <Link
                  to="/client/$login"
                  params={{ login: String(client.login) }}
                  search={{ brokerId: client.brokerId }}
                  className="text-xs font-medium text-primary"
                >
                  View
                </Link>
              </div>
              {client.unavailable ? (
                <p className="mt-3 text-xs text-negative">{client.message}</p>
              ) : (
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Metric
                    label="Balance"
                    value={money(client.balance || 0, client.currency || "USD")}
                  />
                  <Metric
                    label="Equity"
                    value={money(client.equity || 0, client.currency || "USD")}
                  />
                  <Metric
                    label="P/L"
                    value={signedMoney(client.floatingProfit || 0, client.currency || "USD")}
                  />
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label-xs">{label}</p>
      <p className="num mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}
