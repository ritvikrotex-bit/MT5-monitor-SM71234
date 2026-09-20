import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Bell, BellRing, LineChart, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { EmptyState, Metric, ReadOnlyBadge } from "@/components/mt5/primitives";
import { money, signedMoney } from "@/lib/mt5-data";

type Client = {
  login: number;
  name: string;
  group?: string;
  balance?: number;
  equity?: number;
  margin?: number;
  floatingProfit?: number;
  currency?: string;
};
type Position = {
  positionId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice?: number;
  profit: number;
  sl?: number;
  tp?: number;
  openedAt?: string;
};

export const Route = createFileRoute("/client/$login")({ component: ClientDetail });

function ClientDetail() {
  const { login } = Route.useParams();
  const brokerId = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  ).get("brokerId");
  const [client, setClient] = useState<Client | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [error, setError] = useState<string | null>(
    brokerId ? null : "Select a client from live search first.",
  );

  useEffect(() => {
    if (!brokerId) return;
    fetch(`/api/monitored?brokerId=${encodeURIComponent(brokerId)}&login=${login}`).then(
      async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (response.ok) setMonitoring(Boolean(payload.monitored));
      },
    );
    Promise.all([
      fetch(`/api/brokers/${brokerId}/clients/${login}`),
      fetch(`/api/brokers/${brokerId}/clients/${login}/positions`),
    ])
      .then(async ([accountResponse, positionsResponse]) => {
        const account = await accountResponse.json().catch(() => ({}));
        const openPositions = await positionsResponse.json().catch(() => ({}));
        if (!accountResponse.ok) throw new Error(account.message || "Client data is unavailable.");
        if (!positionsResponse.ok)
          throw new Error(openPositions.message || "Open positions are unavailable.");
        setClient(account.client);
        setPositions(openPositions.positions || []);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Client data is unavailable."),
      );
  }, [brokerId, login]);

  if (error) return <Unavailable message={error} />;
  if (!client)
    return (
      <AppShell title="Loading client">
        <p className="mt-6 text-sm text-muted-foreground">Loading live MT5 account data…</p>
      </AppShell>
    );
  const currency = client.currency || "USD";
  const toggleMonitoring = async () => {
    if (!brokerId) return;
    const response = await fetch(
      monitoring
        ? `/api/monitored?brokerId=${encodeURIComponent(brokerId)}&login=${login}`
        : "/api/monitored",
      monitoring
        ? { method: "DELETE" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brokerId, login: Number(login) }),
          },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.message || "Unable to update monitored client.");
      return;
    }
    setMonitoring(!monitoring);
  };
  return (
    <AppShell
      title={client.name}
      subtitle="Live MT5 account data"
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <Link
        to="/search"
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Back to search
      </Link>
      <section className="panel enter mt-3 flex items-start justify-between gap-3 p-4">
        <div>
          <h2 className="text-lg font-semibold">{client.name}</h2>
          <p className="num mt-1 text-xs text-muted-foreground">Login {client.login}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {client.group ? `Group ${client.group}` : "No group returned"} · {currency}
          </p>
        </div>
        <button
          onClick={() => void toggleMonitoring()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-2 text-xs font-medium"
        >
          {monitoring ? (
            <BellRing className="size-3.5 text-primary" />
          ) : (
            <Bell className="size-3.5" />
          )}
          {monitoring ? "Monitoring" : "Monitor client"}
        </button>
      </section>
      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Balance" value={money(client.balance || 0, currency)} />
        <Metric label="Equity" value={money(client.equity || 0, currency)} />
        <Metric label="Margin" value={money(client.margin || 0, currency)} />
        <Metric
          label="Floating P/L"
          value={signedMoney(client.floatingProfit || 0, currency)}
          tone={(client.floatingProfit || 0) >= 0 ? "positive" : "negative"}
        />
      </section>
      <section className="mt-6">
        <h2 className="text-sm font-semibold">
          Live open positions{" "}
          <span className="num text-muted-foreground">({positions.length})</span>
        </h2>
        {positions.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={LineChart}
              title="No open positions"
              description="This live account has no currently open positions."
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {positions.map((position) => (
              <article key={position.positionId} className="panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="num font-semibold">{position.symbol}</h3>
                    <p className="num text-xs text-muted-foreground">
                      {position.volume.toFixed(2)} lots · Opened{" "}
                      {position.openedAt || "time unavailable"}
                    </p>
                  </div>
                  <span
                    className={
                      position.direction === "BUY"
                        ? "rounded-md bg-positive/10 px-2 py-1 text-xs font-bold text-positive"
                        : "rounded-md bg-negative/10 px-2 py-1 text-xs font-bold text-negative"
                    }
                  >
                    {position.direction}
                  </span>
                </div>
                <dl className="num mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="label-xs">Open price</dt>
                    <dd>{position.openPrice}</dd>
                  </div>
                  <div>
                    <dt className="label-xs">Current price</dt>
                    <dd>{position.currentPrice ?? "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt className="label-xs">Stop loss</dt>
                    <dd>{position.sl ?? "Not set"}</dd>
                  </div>
                  <div>
                    <dt className="label-xs">Take profit</dt>
                    <dd>{position.tp ?? "Not set"}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex items-end justify-between border-t border-border pt-3">
                  <div>
                    <p className="label-xs">Live floating P/L</p>
                    <p
                      className={
                        position.profit >= 0
                          ? "num text-lg font-semibold text-positive"
                          : "num text-lg font-semibold text-negative"
                      }
                    >
                      {signedMoney(position.profit, currency)}
                    </p>
                  </div>
                  <p className="num text-xs text-muted-foreground">ID {position.positionId}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Observation only — no trading actions available
      </p>
    </AppShell>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <AppShell title="Client unavailable">
      <div className="mt-6">
        <EmptyState
          icon={ShieldCheck}
          title="Account not available"
          description={message}
          action={
            <Link
              to="/search"
              className="inline-flex rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Back to search
            </Link>
          }
        />
      </div>
    </AppShell>
  );
}
