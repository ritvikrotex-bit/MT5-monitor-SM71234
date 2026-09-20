import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronRight, Search as SearchIcon, SearchX, X } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { EmptyState, ReadOnlyBadge } from "@/components/mt5/primitives";
import { cn } from "@/lib/utils";

type Broker = { id: string; name: string };
type LiveClient = { login: number; name: string; brokerId: string; group?: string };

export const Route = createFileRoute("/search")({ component: SearchPage });

function SearchPage() {
  const [q, setQ] = useState("");
  const [broker, setBroker] = useState("all");
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [results, setResults] = useState<LiveClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/brokers")
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || "Unable to load brokers.");
        setBrokers(payload.brokers || []);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Unable to load brokers."),
      );
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setError(null);
      return;
    }
    const targets = broker === "all" ? brokers : brokers.filter((item) => item.id === broker);
    if (!targets.length) return;
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const replies = await Promise.all(
          targets.map(async (item) => {
            const response = await fetch(
              `/api/brokers/${item.id}/clients/search?q=${encodeURIComponent(term)}`,
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok)
              throw new Error(`${item.name}: ${payload.message || "search unavailable"}`);
            return (payload.clients || []) as LiveClient[];
          }),
        );
        setResults(replies.flat());
      } catch (reason) {
        setResults([]);
        setError(
          reason instanceof Error ? reason.message : "Client search is currently unavailable.",
        );
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [q, broker, brokers]);

  const nameFor = (id: string) => brokers.find((item) => item.id === id)?.name || id;
  return (
    <AppShell
      title="Search clients"
      subtitle="Live MT5 accounts from authorized brokers"
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-input bg-secondary/60 px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          inputMode="search"
          placeholder="Login, name or group"
          aria-label="Search clients"
          className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear search">
            <X className="size-4 text-muted-foreground" />
          </button>
        )}
      </div>
      <div className="mt-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <Chip active={broker === "all"} onClick={() => setBroker("all")}>
          All brokers
        </Chip>
        {brokers.map((item) => (
          <Chip key={item.id} active={broker === item.id} onClick={() => setBroker(item.id)}>
            {item.name}
          </Chip>
        ))}
      </div>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {!q.trim() ? (
        <div className="mt-6">
          <EmptyState
            icon={SearchIcon}
            title="Search a live MT5 account"
            description="Enter an account login, client name, or trading group. Results come directly from the selected broker."
          />
        </div>
      ) : loading ? (
        <p className="mt-6 text-sm text-muted-foreground">Searching the selected broker…</p>
      ) : !error && results.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={SearchX}
            title="No clients found"
            description={`No MT5 account matches “${q}”. Check the selected broker and search term.`}
          />
        </div>
      ) : (
        results.length > 0 && (
          <section className="mt-6">
            <p className="label-xs">
              {results.length} result{results.length === 1 ? "" : "s"}
            </p>
            <div className="mt-3 space-y-3">
              {results.map((client) => (
                <article key={`${client.brokerId}-${client.login}`} className="panel enter p-4">
                  <h2 className="text-base font-semibold">{client.name}</h2>
                  <p className="num mt-0.5 text-xs text-muted-foreground">
                    Login {client.login} · {nameFor(client.brokerId)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {client.group ? `Group ${client.group}` : "No group returned"}
                  </p>
                  <Link
                    to="/client/$login"
                    params={{ login: String(client.login) }}
                    search={{ brokerId: client.brokerId }}
                    className="mt-4 flex w-full items-center justify-center gap-1 rounded-lg border border-border bg-secondary py-2.5 text-sm font-medium hover:bg-accent"
                  >
                    View live client <ChevronRight className="size-4" />
                  </Link>
                </article>
              ))}
            </div>
          </section>
        )
      )}
    </AppShell>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary/45 bg-primary/15 text-primary"
          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
