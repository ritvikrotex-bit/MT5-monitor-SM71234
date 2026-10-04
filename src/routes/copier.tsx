import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import {
  Card,
  Field,
  Stat,
  Tag,
  Toggle,
  eventTone,
  inputClass,
  money,
} from "@/components/mt5/copier-parts";
import {
  SymbolTranslation,
  translationDefaults,
  translationPayload,
  translationProblem,
  type TranslationForm,
} from "@/components/mt5/SymbolTranslation";
import { cn } from "@/lib/utils";

type Role = "MASTER" | "DESTINATION" | "BOTH";

type Account = {
  id: string;
  label: string;
  broker: string;
  server: string;
  login: number;
  role: Role;
};

type Broker = { id: string; name: string; server: string; status: string };

type Master =
  { kind: "MANAGER"; brokerId: string; login: number } | { kind: "TERMINAL"; accountId: string };

type Rules = {
  autoMatch: boolean;
  lotMode: "FIXED" | "MULTIPLIER" | "BALANCE" | "EQUITY" | "EQUITY_STEP" | "RISK_PERCENT";
  lotValue: number;
  equityStep?: number;
  maxLot: number;
  minVolumeAction: "SKIP" | "MIN";
  symbolSuffix: string;
  symbolMap: Record<string, string>;
  allowSymbols: string[];
  denySymbols: string[];
  reverse: boolean;
  copySl?: boolean;
  copyTp?: boolean;
  /** Links saved before SL and TP were split. */
  copySlTp?: boolean;
  copyExisting: boolean;
  maxOpenPositions: number;
  maxSlippagePoints: number;
  maxTradesPerDay?: number;
  maxBuyLots?: number;
  maxSellLots?: number;
  sessionStart?: string;
  sessionEnd?: string;
  sessionDays?: number[];
  maxDailyLoss?: number;
  maxConsecutiveLosses?: number;
  maxLossPerTrade?: number;
  exitMode?: "MASTER" | "TRAILING";
  trailActivation?: number;
  trailDrawdownPct?: number;
};

type LinkStatus = {
  state: {
    copiedPositions: number;
    copiedCount: number;
    haltedReason: string | null;
    ignored: number;
    tradesToday?: number;
    riskBlock?: string | null;
    today?: { realized: number; floating: number; total: number; lossStreak: number } | null;
  };
  cycle: {
    error?: string | null;
    masterPositions?: number;
    masterEquity?: number;
    destEquity?: number;
    at?: number;
  };
};

type CopyLink = {
  id: string;
  label: string;
  master: Master;
  destAccountId: string;
  rules: Rules;
  enabled: boolean;
  dryRun: boolean;
  maxDrawdownPct: number;
  status: LinkStatus | null;
};

type CopierEvent = {
  at: number;
  linkId: string;
  kind: string;
  message: string;
  dryRun: boolean;
};

/** How an account's terminal worker is doing, as the copier reports it. */
type WorkerStatus = {
  running: boolean;
  ready?: boolean;
  lastError: string | null;
  lastOkAt?: number | null;
  starts?: number;
};

type TestStep = {
  key: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  sample?: string;
};

type TestResult = { ok: boolean; at: number; steps: TestStep[] };

/** One copy from the trade journal. Times are epoch seconds. */
type JournalTrade = {
  status: "open" | "closed";
  linkId: string;
  linkLabel?: string;
  masterTicket: number;
  masterSymbol?: string;
  ticket?: number;
  symbol?: string;
  side?: string;
  volume?: number;
  price?: number;
  openedAt?: number;
  latencyMs?: number;
  executionMs?: number;
  slippagePoints?: number;
  closedAt?: number;
  closeReason?: string;
  profit?: number;
};

type Snapshot = {
  account: {
    login: number;
    name: string;
    server: string;
    company: string;
    currency: string;
    balance: number;
    equity: number;
    leverage: number;
    hedging: boolean;
    tradeMode: number;
    tradeAllowed: boolean;
  };
  positions: { ticket: number; symbol: string; side: string; volume: number }[];
};

export const Route = createFileRoute("/copier")({ component: CopierPage });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "That did not work.");
  return data as T;
}

function CopierPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [links, setLinks] = useState<CopyLink[]>([]);
  const [events, setEvents] = useState<CopierEvent[]>([]);
  const [service, setService] = useState<{ running: boolean; error: string | null }>({
    running: false,
    error: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, Snapshot | string>>({});
  const [workers, setWorkers] = useState<Record<string, WorkerStatus>>({});
  const [tests, setTests] = useState<Record<string, TestResult | string>>({});

  const load = useCallback(async () => {
    const data = await api<{
      accounts: Account[];
      brokers: Broker[];
      links: CopyLink[];
      workers?: Record<string, WorkerStatus>;
      events: CopierEvent[];
      service: { running: boolean; error: string | null };
    }>("/api/copier");
    setAccounts(data.accounts);
    setBrokers(data.brokers);
    setLinks(data.links);
    setWorkers(data.workers ?? {});
    setEvents(data.events);
    setService(data.service);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const accountById = (id: string) => accounts.find((a) => a.id === id);
  const brokerById = (id: string) => brokers.find((b) => b.id === id);

  const masterLabel = (master: Master) => {
    if (master.kind === "MANAGER") {
      return `${brokerById(master.brokerId)?.name ?? "unknown broker"} · ${master.login}`;
    }
    const account = accountById(master.accountId);
    return account ? `${account.label} · ${account.login}` : "unknown account";
  };

  const live = links.filter((l) => l.enabled && !l.dryRun).length;
  const running = links.filter((l) => l.enabled).length;
  const halted = links.filter((l) => l.status?.state.haltedReason).length;
  const openCopies = links.reduce((n, l) => n + (l.status?.state.copiedPositions ?? 0), 0);

  return (
    <AppShell
      title="Trade Copier"
      subtitle="Copy trades from master accounts onto destination accounts"
      right={
        <button
          onClick={() => run("reload", load)}
          className="grid size-10 place-items-center rounded-full border border-border bg-secondary text-muted-foreground hover:text-foreground"
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-4", busy === "reload" && "animate-spin")} />
        </button>
      }
    >
      <div className="space-y-4">
        {/* ---------------- overview ---------------- */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat
            label="Copier service"
            value={service.error ? "Offline" : service.running ? "Running" : "Idle"}
            tone={service.error ? "danger" : service.running ? "ok" : "muted"}
            {...(service.error ? { hint: "nothing is being copied" } : {})}
          />
          <Stat
            label="Links"
            value={`${running} of ${links.length}`}
            hint={live > 0 ? `${live} placing real orders` : "none live"}
            tone={live > 0 ? "warn" : "muted"}
          />
          <Stat label="Open copies" value={String(openCopies)} />
          <Stat
            label="Halted"
            value={String(halted)}
            tone={halted > 0 ? "danger" : "muted"}
            {...(halted > 0 ? { hint: "needs arming" } : {})}
          />
        </div>

        {service.error && (
          <Banner tone="danger">
            The copier service is not responding, so nothing is being copied right now.{" "}
            {service.error}
          </Banner>
        )}
        {error && (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {notice && <Banner tone="ok">{notice}</Banner>}

        {/* ---------------- links ---------------- */}
        <Card
          title="Copy links"
          description="Each link copies one master onto one destination. Add as many as you need in either direction: several masters onto one account, or one master fanned out across several."
          action={
            <button
              onClick={() => setAddingLink((v) => !v)}
              disabled={accounts.length < 1}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground disabled:opacity-50"
            >
              <Plus className="size-3.5" /> Add link
            </button>
          }
        >
          {addingLink && (
            <LinkForm
              accounts={accounts}
              brokers={brokers}
              busy={busy === "add-link"}
              onCancel={() => setAddingLink(false)}
              onSave={(body) =>
                run(
                  "add-link",
                  async () => {
                    await api("/api/copier/links", { method: "POST", body: JSON.stringify(body) });
                    setAddingLink(false);
                  },
                  "Link created. It is stopped and in dry run until you start it.",
                )
              }
            />
          )}

          <div className="mt-3 space-y-4">
            {links.length === 0 && !addingLink && (
              <Empty>
                {accounts.length === 0
                  ? "Add a destination account below, then create your first link."
                  : "No links yet."}
              </Empty>
            )}
            {groupByMaster(links).map(([key, group]) => {
              const runningCount = group.filter((l) => l.enabled).length;
              const pause = runningCount > 0;
              return (
                <section key={key} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <p className="min-w-0 text-xs break-words text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        📡 {masterLabel(group[0]!.master)}
                      </span>{" "}
                      · {group.length} link{group.length === 1 ? "" : "s"} · {runningCount} running
                    </p>
                    <button
                      onClick={() =>
                        void run(
                          `master-${key}`,
                          async () => {
                            for (const l of group) {
                              if (l.enabled === !pause) continue;
                              await api(`/api/copier/links/${l.id}`, {
                                method: "PATCH",
                                body: JSON.stringify({ enabled: !pause }),
                              });
                            }
                          },
                          pause
                            ? "Master paused: none of its links copy until you resume it."
                            : "Master resumed.",
                        )
                      }
                      disabled={busy === `master-${key}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary disabled:opacity-50"
                    >
                      {pause ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                      {pause ? "Pause master" : "Resume master"}
                    </button>
                  </div>
                  {group.map((link) => (
                    <LinkRow
                      key={link.id}
                      link={link}
                      masterLabel={masterLabel(link.master)}
                      dest={accountById(link.destAccountId)}
                      busy={busy}
                      onAction={run}
                      test={tests[link.id]}
                      onTest={() =>
                        run(`test-${link.id}`, async () => {
                          try {
                            const result = await api<TestResult>(
                              `/api/copier/links/${link.id}/test`,
                              {
                                method: "POST",
                              },
                            );
                            setTests((t) => ({ ...t, [link.id]: result }));
                          } catch (e) {
                            setTests((t) => ({
                              ...t,
                              [link.id]: e instanceof Error ? e.message : "The test run failed.",
                            }));
                            throw e;
                          }
                        })
                      }
                      onDismissTest={() =>
                        setTests((t) => {
                          const { [link.id]: _done, ...rest } = t;
                          return rest;
                        })
                      }
                      editing={editingLink === link.id}
                      onToggleEdit={() =>
                        setEditingLink((current) => (current === link.id ? null : link.id))
                      }
                      onSaveEdit={(body) =>
                        run(
                          `link-${link.id}`,
                          async () => {
                            await api(`/api/copier/links/${link.id}`, {
                              method: "PATCH",
                              body: JSON.stringify(body),
                            });
                            setEditingLink(null);
                          },
                          "Link updated.",
                        )
                      }
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </Card>

        {/* ---------------- accounts ---------------- */}
        <Card
          title="MT5 accounts"
          description="Destinations are traded on and need the account's trading password. You only need an account here to read a master by logging in to it; a master read through a broker's Manager connection needs nothing."
          action={
            <button
              onClick={() => setAddingAccount((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground"
            >
              <Plus className="size-3.5" /> Add account
            </button>
          }
        >
          {addingAccount && (
            <AccountForm
              busy={busy === "add-account"}
              onCancel={() => setAddingAccount(false)}
              onSave={(body) =>
                run(
                  "add-account",
                  async () => {
                    await api("/api/copier/accounts", {
                      method: "POST",
                      body: JSON.stringify(body),
                    });
                    setAddingAccount(false);
                  },
                  "Account saved.",
                )
              }
            />
          )}

          <div className="mt-3 space-y-2">
            {accounts.length === 0 && !addingAccount && (
              <Empty>No accounts yet. Add the account you want trades copied onto.</Empty>
            )}
            {accounts.map((account) => (
              <div key={account.id}>
                <AccountRow
                  account={account}
                  result={probe[account.id]}
                  worker={workers[account.id]}
                  busy={busy}
                  onProbe={() =>
                    run(`probe-${account.id}`, async () => {
                      try {
                        const snap = await api<Snapshot>(
                          `/api/copier/accounts/${account.id}/probe`,
                          {
                            method: "POST",
                          },
                        );
                        setProbe((p) => ({ ...p, [account.id]: snap }));
                      } catch (e) {
                        setProbe((p) => ({
                          ...p,
                          [account.id]: e instanceof Error ? e.message : "Could not connect.",
                        }));
                        throw e;
                      }
                    })
                  }
                  onEdit={() =>
                    setEditingAccount((prev) => (prev === account.id ? null : account.id))
                  }
                  onDelete={() => {
                    if (!confirm(`Remove ${account.label}?`)) return;
                    void run(
                      `del-${account.id}`,
                      () => api(`/api/copier/accounts/${account.id}`, { method: "DELETE" }),
                      "Account removed.",
                    );
                  }}
                />
                {editingAccount === account.id && (
                  <AccountForm
                    initial={account}
                    busy={busy === `edit-${account.id}`}
                    onCancel={() => setEditingAccount(null)}
                    onSave={(body) =>
                      run(
                        `edit-${account.id}`,
                        async () => {
                          await api(`/api/copier/accounts/${account.id}`, {
                            method: "PATCH",
                            body: JSON.stringify(body),
                          });
                          setEditingAccount(null);
                        },
                        "Account updated.",
                      )
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* ---------------- journal ---------------- */}
        {links.length > 0 && <TradeJournal />}

        {/* ---------------- activity ---------------- */}
        <Card title="Recent activity">
          <div className="mt-2 space-y-1.5">
            {events.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing yet. Every decision shows up here as soon as a link is running, including in
                dry run.
              </p>
            )}
            {events.map((event, index) => (
              <div
                key={`${event.at}-${index}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-secondary/40 px-2.5 py-1.5 text-[11px]"
              >
                <span className="num shrink-0 text-muted-foreground">
                  {new Date(event.at * 1000).toLocaleTimeString()}
                </span>
                <Tag tone={eventTone(event.kind)} text={event.kind} />
                {event.dryRun && <Tag tone="muted" text="dry run" />}
                <span className="min-w-0 flex-1 break-words">{event.message}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

/** Links grouped under the master they copy, in the order they were created. */
function groupByMaster(links: CopyLink[]): [string, CopyLink[]][] {
  const groups = new Map<string, CopyLink[]>();
  for (const link of links) {
    const m = link.master;
    const key = m.kind === "MANAGER" ? `M:${m.brokerId}:${m.login}` : `T:${m.accountId}`;
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  return [...groups.entries()];
}

const CLOSE_REASON: Record<string, string> = {
  "master closed": "master closed",
  "trailing exit": "trailing exit",
  "loss per trade": "loss stop",
};

/** Every copy with its latency, slippage and result; downloadable as CSV. */
function TradeJournal() {
  const [trades, setTrades] = useState<JournalTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ trades: JournalTrade[] }>("/api/copier/journal?limit=200");
      setTrades(data.trades);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the journal.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const closed = (trades ?? []).filter((t) => t.status === "closed");
  const totalPl = closed.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  const latencies = (trades ?? []).flatMap((t) => (t.latencyMs != null ? [t.latencyMs] : []));
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  return (
    <Card
      title="Trade journal"
      description="Every copy: when the master executed, how long the copy took, how far it slipped, and what it made."
      action={
        <a
          href="/api/copier/journal?format=csv&limit=5000"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold whitespace-nowrap hover:bg-secondary"
        >
          Download CSV
        </a>
      }
    >
      {error && <p className="mt-2 text-[11px] break-words text-destructive">{error}</p>}
      {trades && trades.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No copies recorded yet. Copies made from now on appear here.
        </p>
      )}
      {trades && trades.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{trades.length} copies</span>
            <span>
              Closed P/L{" "}
              <span
                className={cn(
                  "num font-semibold",
                  totalPl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                )}
              >
                {totalPl >= 0 ? "+" : ""}
                {totalPl.toFixed(2)}
              </span>
            </span>
            {avgLatency !== null && <span>Average latency {avgLatency} ms</span>}
          </div>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border/70">
            <table className="w-full min-w-[720px] text-left text-[11px]">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Opened</th>
                  <th className="px-2 py-1.5 font-medium">Master</th>
                  <th className="px-2 py-1.5 font-medium">Copy</th>
                  <th className="px-2 py-1.5 font-medium">Fill</th>
                  <th className="px-2 py-1.5 font-medium">Latency</th>
                  <th className="px-2 py-1.5 font-medium">Slippage</th>
                  <th className="px-2 py-1.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={`${t.linkId}-${t.masterTicket}`} className="border-t border-border/60">
                    <td className="num px-2 py-1.5 whitespace-nowrap">
                      {t.openedAt ? new Date(t.openedAt * 1000).toLocaleString() : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {t.masterSymbol ?? "—"} <span className="num">#{t.masterTicket}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      {t.side} {t.volume} {t.symbol}{" "}
                      {t.ticket ? <span className="num">#{t.ticket}</span> : null}
                    </td>
                    <td className="num px-2 py-1.5">{t.price ?? "—"}</td>
                    <td className="num px-2 py-1.5">
                      {t.latencyMs != null
                        ? `${t.latencyMs} ms`
                        : t.executionMs != null
                          ? `fill ${t.executionMs} ms`
                          : "—"}
                    </td>
                    <td className="num px-2 py-1.5">
                      {t.slippagePoints != null
                        ? `${t.slippagePoints > 0 ? "+" : ""}${t.slippagePoints} pts`
                        : "—"}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {t.status === "open" ? (
                        <Tag tone="info" text="open" />
                      ) : (
                        <>
                          <span
                            className={cn(
                              "num font-semibold",
                              (t.profit ?? 0) >= 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-destructive",
                            )}
                          >
                            {(t.profit ?? 0) >= 0 ? "+" : ""}
                            {(t.profit ?? 0).toFixed(2)}
                          </span>
                          <span className="ml-1 text-muted-foreground">
                            {CLOSE_REASON[t.closeReason ?? ""] ?? t.closeReason}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: "danger" | "ok";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-xl border p-3 text-xs",
        tone === "danger"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      {tone === "danger" && <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <p className="min-w-0 flex-1 break-words">{children}</p>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function AccountRow({
  account,
  result,
  worker,
  busy,
  onProbe,
  onEdit,
  onDelete,
}: {
  account: Account;
  result: Snapshot | string | undefined;
  worker: WorkerStatus | undefined;
  busy: string | null;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const restarts = Math.max(0, (worker?.starts ?? 0) - 1);
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold break-words">{account.label}</p>
          <p className="text-xs break-all text-muted-foreground">
            {account.broker ? `${account.broker} · ` : ""}
            {account.server} · {account.login}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Tag
              tone={account.role === "MASTER" ? "info" : account.role === "BOTH" ? "muted" : "warn"}
              text={
                account.role === "MASTER"
                  ? "master only · never traded on"
                  : account.role === "BOTH"
                    ? "master or destination"
                    : "destination"
              }
            />
            {worker && (
              <Tag
                tone={
                  worker.lastError
                    ? "warn"
                    : worker.running && worker.ready === false
                      ? "info"
                      : worker.running
                        ? "ok"
                        : "muted"
                }
                text={
                  worker.lastError
                    ? "terminal problem"
                    : worker.running && worker.ready === false
                      ? "terminal starting…"
                      : worker.running
                        ? "terminal connected"
                        : "terminal idle · starts when needed"
                }
              />
            )}
            {restarts > 0 && (
              <Tag tone="muted" text={`recovered ${restarts}× since the copier started`} />
            )}
          </div>
          {worker?.lastError && (
            <p className="mt-1.5 text-[11px] break-words text-amber-600 dark:text-amber-400">
              {worker.lastError}
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <button
            onClick={onProbe}
            disabled={busy === `probe-${account.id}`}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary disabled:opacity-50"
          >
            {busy === `probe-${account.id}` ? "Checking..." : "Test login"}
          </button>
          <button
            onClick={onEdit}
            className="grid size-7 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-secondary"
            aria-label={`Edit ${account.label}`}
          >
            <Settings2 className="size-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="grid size-7 place-items-center rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10"
            aria-label={`Remove ${account.label}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      {typeof result === "string" && (
        <p className="mt-2 rounded-lg bg-destructive/10 p-2 text-[11px] break-words text-destructive">
          {result}
        </p>
      )}
      {result && typeof result !== "string" && (
        <div className="mt-2 space-y-1 rounded-lg bg-background/60 p-2 text-[11px]">
          <p className="break-words">
            <span className="font-semibold">{result.account.name}</span> · {result.account.company}
          </p>
          <p className="text-muted-foreground">
            Balance {money(result.account.balance, result.account.currency)} · equity{" "}
            {money(result.account.equity, result.account.currency)} · leverage 1:
            {result.account.leverage} · {result.positions.length} open
          </p>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Tag
              tone={result.account.tradeMode === 2 ? "danger" : "ok"}
              text={
                result.account.tradeMode === 2
                  ? "REAL MONEY"
                  : result.account.tradeMode === 1
                    ? "contest"
                    : "demo"
              }
            />
            <Tag
              tone={result.account.hedging ? "ok" : "warn"}
              text={result.account.hedging ? "hedging" : "netting"}
            />
            <Tag
              tone={result.account.tradeAllowed ? "ok" : "warn"}
              text={result.account.tradeAllowed ? "can trade" : "read only"}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const STEP_STYLE: Record<TestStep["status"], { icon: typeof CheckCircle2; className: string }> = {
  pass: { icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  warn: { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  fail: { icon: XCircle, className: "text-destructive" },
};

/** The outcome of a test run, one line per step. */
function TestRunPanel({
  result,
  onDismiss,
}: {
  result: TestResult | string;
  onDismiss: () => void;
}) {
  if (typeof result === "string") {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
        <XCircle className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 break-words">Test run could not finish: {result}</p>
        <button onClick={onDismiss} aria-label="Dismiss test result">
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  const failed = result.steps.filter((s) => s.status === "fail").length;
  const warned = result.steps.filter((s) => s.status === "warn").length;
  return (
    <div
      className={cn(
        "mt-2 rounded-lg border p-2.5 text-[11px]",
        result.ok
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 font-semibold">
          {result.ok
            ? warned
              ? `Test run passed with ${warned} note${warned === 1 ? "" : "s"}`
              : "Test run passed: this link is ready to copy"
            : `Test run found ${failed} problem${failed === 1 ? "" : "s"}`}
          <span className="ml-1.5 font-normal text-muted-foreground">
            · {new Date(result.at * 1000).toLocaleTimeString()} · no order was placed
          </span>
        </p>
        <button onClick={onDismiss} aria-label="Dismiss test result">
          <X className="size-3.5" />
        </button>
      </div>
      <ul className="mt-2 space-y-1.5">
        {result.steps.map((step) => {
          const { icon: Icon, className } = STEP_STYLE[step.status];
          return (
            <li key={step.key} className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} />
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">
                  {step.title}
                  {step.sample && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      ({step.sample})
                    </span>
                  )}
                </p>
                <p className="break-words text-muted-foreground">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background/60 px-2 py-1.5">
      <p className="text-muted-foreground">{label}</p>
      <p className="num font-semibold break-words">{value}</p>
    </div>
  );
}

function LinkRow({
  link,
  masterLabel,
  dest,
  busy,
  onAction,
  test,
  onTest,
  onDismissTest,
  editing,
  onToggleEdit,
  onSaveEdit,
}: {
  link: CopyLink;
  masterLabel: string;
  dest: Account | undefined;
  busy: string | null;
  onAction: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
  test: TestResult | string | undefined;
  onTest: () => void;
  onDismissTest: () => void;
  editing: boolean;
  onToggleEdit: () => void;
  onSaveEdit: (body: Record<string, unknown>) => void;
}) {
  const halted = link.status?.state.haltedReason ?? null;
  const cycleError = link.status?.cycle.error ?? null;
  const rules = link.rules;
  const mappings = Object.keys(rules.symbolMap ?? {}).length;
  const patch = (body: Record<string, unknown>, done?: string) =>
    onAction(
      `link-${link.id}`,
      () => api(`/api/copier/links/${link.id}`, { method: "PATCH", body: JSON.stringify(body) }),
      done,
    );

  const sizing =
    rules.lotMode === "FIXED"
      ? `fixed ${rules.lotValue} lots`
      : rules.lotMode === "MULTIPLIER"
        ? `master lot x${rules.lotValue}`
        : `auto-scale by ${rules.lotMode.toLowerCase()}${
            rules.lotValue !== 1 ? ` x${rules.lotValue}` : ""
          }`;

  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-semibold break-words">{link.label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs break-words text-muted-foreground">
            <Server className="size-3 shrink-0" />
            <span>{masterLabel}</span>
            <Tag
              tone="muted"
              text={link.master.kind === "MANAGER" ? "via Manager" : "via MT5 login"}
            />
            <ArrowRight className="size-3 shrink-0" />
            <span>{dest ? `${dest.label} · ${dest.login}` : "unknown destination"}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Tag tone={link.enabled ? "ok" : "muted"} text={link.enabled ? "running" : "stopped"} />
            <Tag tone={link.dryRun ? "warn" : "danger"} text={link.dryRun ? "dry run" : "LIVE"} />
            <Tag tone="muted" text={sizing} />
            {rules.maxLot > 0 && <Tag tone="muted" text={`max ${rules.maxLot} lots`} />}
            {rules.symbolSuffix && <Tag tone="muted" text={`suffix ${rules.symbolSuffix}`} />}
            {mappings > 0 && (
              <Tag tone="muted" text={`${mappings} symbol mapping${mappings === 1 ? "" : "s"}`} />
            )}
            {rules.reverse && <Tag tone="warn" text="reversed" />}
            {rules.exitMode === "TRAILING" ? (
              <Tag
                tone="info"
                text={`trailing ${rules.trailDrawdownPct}% from +${rules.trailActivation ?? 0}`}
              />
            ) : (
              <>
                {!(rules.copySl ?? rules.copySlTp ?? true) && <Tag tone="muted" text="no SL" />}
                {!(rules.copyTp ?? rules.copySlTp ?? true) && <Tag tone="muted" text="no TP" />}
              </>
            )}
            {rules.maxOpenPositions > 0 && (
              <Tag tone="muted" text={`max ${rules.maxOpenPositions} open`} />
            )}
            {(rules.maxTradesPerDay ?? 0) > 0 && (
              <Tag tone="muted" text={`max ${rules.maxTradesPerDay} trades/day`} />
            )}
            {(rules.maxBuyLots ?? 0) > 0 && (
              <Tag tone="muted" text={`BUY ≤ ${rules.maxBuyLots} lots`} />
            )}
            {(rules.maxSellLots ?? 0) > 0 && (
              <Tag tone="muted" text={`SELL ≤ ${rules.maxSellLots} lots`} />
            )}
            {rules.sessionStart && (
              <Tag tone="muted" text={`${rules.sessionStart}–${rules.sessionEnd} server`} />
            )}
            {(rules.maxDailyLoss ?? 0) > 0 && (
              <Tag tone="muted" text={`daily loss ≤ ${rules.maxDailyLoss}`} />
            )}
            {(rules.maxConsecutiveLosses ?? 0) > 0 && (
              <Tag tone="muted" text={`pause after ${rules.maxConsecutiveLosses} losses`} />
            )}
            {(rules.maxLossPerTrade ?? 0) > 0 && (
              <Tag tone="muted" text={`close copy at -${rules.maxLossPerTrade}`} />
            )}
            {link.maxDrawdownPct > 0 && (
              <Tag tone="muted" text={`stop at -${link.maxDrawdownPct}%`} />
            )}
          </div>
          {link.status && (
            <p className="mt-1.5 text-[11px] break-words text-muted-foreground">
              Today (broker day): {link.status.state.tradesToday ?? 0} copied
              {link.status.state.today && (
                <>
                  {" "}
                  · P/L{" "}
                  <span
                    className={cn(
                      "num font-medium",
                      link.status.state.today.total >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive",
                    )}
                  >
                    {link.status.state.today.total >= 0 ? "+" : ""}
                    {link.status.state.today.total.toFixed(2)}
                  </span>{" "}
                  · losing streak {link.status.state.today.lossStreak}
                </>
              )}
            </p>
          )}
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <button
            onClick={onTest}
            disabled={busy === `test-${link.id}`}
            title="Check the whole link without placing an order"
            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            <FlaskConical
              className={cn("size-3.5", busy === `test-${link.id}` && "animate-pulse")}
            />
            {busy === `test-${link.id}` ? "Testing..." : "Test run"}
          </button>
          <button
            onClick={onToggleEdit}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
              editing
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border hover:bg-secondary",
            )}
            aria-expanded={editing}
          >
            <Settings2 className="size-3.5" />
            Edit
          </button>
          <button
            onClick={() => void patch({ enabled: !link.enabled })}
            disabled={busy === `link-${link.id}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap disabled:opacity-50",
              link.enabled
                ? "border border-border hover:bg-secondary"
                : "bg-primary text-primary-foreground",
            )}
          >
            {link.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {link.enabled ? "Stop" : "Start"}
          </button>
          <button
            onClick={() => {
              if (link.dryRun) {
                const ok = confirm(
                  `Go live on "${link.label}"?\n\nFrom now on this link places real orders on ` +
                    `${dest ? `${dest.label} (${dest.login})` : "the destination account"}.`,
                );
                if (!ok) return;
              }
              void patch(
                { dryRun: !link.dryRun },
                link.dryRun ? "This link is now placing real orders." : "Back to dry run.",
              );
            }}
            disabled={busy === `link-${link.id}`}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary disabled:opacity-50"
          >
            {link.dryRun ? "Go live" : "Back to dry run"}
          </button>
          <button
            onClick={() => {
              if (!confirm("Close every position this link owns on the destination?")) return;
              void onAction(
                `link-${link.id}`,
                () => api(`/api/copier/links/${link.id}/flatten`, { method: "POST" }),
                "Closed the positions this link owns.",
              );
            }}
            disabled={busy === `link-${link.id}`}
            className="rounded-lg border border-destructive/40 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Close all
          </button>
          <button
            onClick={() => {
              if (!confirm(`Delete "${link.label}"? Open copies are left where they are.`)) return;
              void onAction(
                `link-${link.id}`,
                () => api(`/api/copier/links/${link.id}`, { method: "DELETE" }),
                "Link deleted.",
              );
            }}
            className="grid size-7 place-items-center rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10"
            aria-label={`Delete ${link.label}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      {halted && (
        <div className="mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">
            Halted: {halted}. Fix the cause, then arm it again. Arming resumes from now, so whatever
            the master is holding at that moment is left alone.
          </p>
          <button
            onClick={() =>
              void onAction(
                `link-${link.id}`,
                () => api(`/api/copier/links/${link.id}/arm`, { method: "POST" }),
                "Link armed.",
              )
            }
            className="shrink-0 rounded-lg border border-destructive/40 px-2 py-0.5 font-semibold whitespace-nowrap"
          >
            Arm
          </button>
        </div>
      )}
      {!halted && link.status?.state.riskBlock && (
        <div className="mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">
            Copying paused: {link.status.state.riskBlock}. Open copies are still managed. Resuming
            starts a fresh count and leaves trades the master already holds alone.
          </p>
          <button
            onClick={() =>
              void onAction(
                `link-${link.id}`,
                () => api(`/api/copier/links/${link.id}/arm`, { method: "POST" }),
                "Copying resumed.",
              )
            }
            className="shrink-0 rounded-lg border border-amber-500/50 px-2 py-0.5 font-semibold whitespace-nowrap"
          >
            Resume
          </button>
        </div>
      )}
      {!halted && cycleError && (
        <p className="mt-2 rounded-lg bg-amber-500/10 p-2 text-[11px] break-words text-amber-600 dark:text-amber-400">
          {cycleError}
        </p>
      )}
      {test !== undefined && <TestRunPanel result={test} onDismiss={onDismissTest} />}
      {editing && (
        <EditLinkForm
          link={link}
          destAccountId={dest?.id}
          busy={busy === `link-${link.id}`}
          onCancel={onToggleEdit}
          onSave={onSaveEdit}
        />
      )}
      {link.status && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <MiniStat label="Open copies" value={String(link.status.state.copiedPositions)} />
          <MiniStat label="Copied in total" value={String(link.status.state.copiedCount)} />
          <MiniStat label="Master open" value={String(link.status.cycle.masterPositions ?? "—")} />
          <MiniStat
            label="Destination equity"
            value={
              link.status.cycle.destEquity !== undefined ? money(link.status.cycle.destEquity) : "—"
            }
          />
        </div>
      )}
    </div>
  );
}

function FormButtons({
  busy,
  onCancel,
  submitLabel,
}: {
  busy: boolean;
  onCancel: () => void;
  submitLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground disabled:opacity-50"
      >
        {busy ? "Saving..." : submitLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium whitespace-nowrap"
      >
        Cancel
      </button>
    </div>
  );
}

function AccountForm({
  initial,
  onSave,
  onCancel,
  busy,
}: {
  initial?: Account;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [form, setForm] = useState({
    label: initial?.label ?? "",
    broker: initial?.broker ?? "",
    server: initial?.server ?? "",
    login: initial ? String(initial.login) : "",
    password: "",
    role: (initial?.role ?? "DESTINATION") as Role,
  });
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...form, login: Number(form.login) });
      }}
      className="mt-3 space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <input
            required
            className={inputClass}
            value={form.label}
            onChange={set("label")}
            placeholder="e.g. Slave — Main account"
          />
        </Field>
        <Field label="Broker" hint="Optional, for your own reference.">
          <input
            className={inputClass}
            value={form.broker}
            onChange={set("broker")}
            placeholder="e.g. Your broker's name"
          />
        </Field>
        <Field
          label="Server"
          hint="The server name as MT5 shows it, or host:port for a server the terminal does not list."
        >
          <input
            required
            className={inputClass}
            value={form.server}
            onChange={set("server")}
            placeholder="e.g. BrokerName-Live"
          />
        </Field>
        <Field label="MT5 login">
          <input
            required
            type="number"
            className={inputClass}
            value={form.login}
            onChange={set("login")}
            placeholder="e.g. 12345678"
          />
        </Field>
        <Field
          label="Password"
          hint={
            initial
              ? "Leave blank to keep the current password."
              : "A destination needs the trading password. A master read by login only needs its investor password."
          }
        >
          <input
            required={!initial}
            type="password"
            className={inputClass}
            value={form.password}
            onChange={set("password")}
            placeholder={initial ? "Leave blank to keep unchanged" : ""}
          />
        </Field>
        <Field label="Use as" hint="A master-only account is kept out of every destination picker.">
          <select className={inputClass} value={form.role} onChange={set("role")}>
            <option value="DESTINATION">Destination — trades are placed on it</option>
            <option value="MASTER">Master only — never traded on</option>
            <option value="BOTH">Either</option>
          </select>
        </Field>
      </div>
      <FormButtons
        busy={busy}
        onCancel={onCancel}
        submitLabel={initial ? "Update account" : "Save account"}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rules, shared by the create and edit forms so the two cannot drift apart.
// ---------------------------------------------------------------------------

type RulesForm = {
  lotMode: Rules["lotMode"];
  lotValue: string;
  equityStep: string;
  maxLot: string;
  minVolumeAction: Rules["minVolumeAction"];
  maxOpenPositions: string;
  maxSlippagePoints: string;
  maxDrawdownPct: string;
  reverse: boolean;
  copySl: boolean;
  copyTp: boolean;
  copyExisting: boolean;
  maxTradesPerDay: string;
  maxBuyLots: string;
  maxSellLots: string;
  sessionStart: string;
  sessionEnd: string;
  sessionDays: number[];
  maxDailyLoss: string;
  maxConsecutiveLosses: string;
  maxLossPerTrade: string;
  exitMode: "MASTER" | "TRAILING";
  trailActivation: string;
  trailDrawdownPct: string;
};

/** Toggles hold booleans; the day picker holds a list; everything else is text. */
type TextKey = {
  [K in keyof RulesForm]: RulesForm[K] extends string ? K : never;
}[keyof RulesForm];
type BoolKey = {
  [K in keyof RulesForm]: RulesForm[K] extends boolean ? K : never;
}[keyof RulesForm];

function rulesDefaults(link?: CopyLink): RulesForm {
  const r = link?.rules;
  const legacyStops = r?.copySlTp ?? true;
  return {
    lotMode: r?.lotMode ?? "BALANCE",
    lotValue: String(r?.lotValue ?? 1),
    equityStep: String(r?.equityStep ?? 1000),
    maxLot: String(r?.maxLot ?? 0),
    minVolumeAction: r?.minVolumeAction ?? "SKIP",
    maxOpenPositions: String(r?.maxOpenPositions ?? 0),
    maxSlippagePoints: String(r?.maxSlippagePoints ?? 20),
    maxDrawdownPct: String(link?.maxDrawdownPct ?? 0),
    reverse: r?.reverse ?? false,
    copySl: r?.copySl ?? legacyStops,
    copyTp: r?.copyTp ?? legacyStops,
    copyExisting: r?.copyExisting ?? false,
    maxTradesPerDay: String(r?.maxTradesPerDay ?? 0),
    maxBuyLots: String(r?.maxBuyLots ?? 0),
    maxSellLots: String(r?.maxSellLots ?? 0),
    sessionStart: r?.sessionStart ?? "",
    sessionEnd: r?.sessionEnd ?? "",
    sessionDays: r?.sessionDays ?? [],
    maxDailyLoss: String(r?.maxDailyLoss ?? 0),
    maxConsecutiveLosses: String(r?.maxConsecutiveLosses ?? 0),
    maxLossPerTrade: String(r?.maxLossPerTrade ?? 0),
    exitMode: r?.exitMode ?? "MASTER",
    trailActivation: String(r?.trailActivation ?? 5),
    trailDrawdownPct: String(r?.trailDrawdownPct || 20),
  };
}

function rulesPayload(form: RulesForm, translation: TranslationForm) {
  return {
    maxDrawdownPct: Number(form.maxDrawdownPct),
    rules: {
      lotMode: form.lotMode,
      lotValue: Number(form.lotValue),
      equityStep: Number(form.equityStep),
      maxLot: Number(form.maxLot),
      minVolumeAction: form.minVolumeAction,
      maxOpenPositions: Number(form.maxOpenPositions),
      maxSlippagePoints: Number(form.maxSlippagePoints),
      reverse: form.reverse,
      copySl: form.copySl,
      copyTp: form.copyTp,
      copyExisting: form.copyExisting,
      maxTradesPerDay: Number(form.maxTradesPerDay),
      maxBuyLots: Number(form.maxBuyLots),
      maxSellLots: Number(form.maxSellLots),
      sessionStart: form.sessionStart,
      sessionEnd: form.sessionEnd,
      sessionDays: form.sessionDays,
      maxDailyLoss: Number(form.maxDailyLoss),
      maxConsecutiveLosses: Number(form.maxConsecutiveLosses),
      maxLossPerTrade: Number(form.maxLossPerTrade),
      exitMode: form.exitMode,
      trailActivation: Number(form.trailActivation),
      trailDrawdownPct: form.exitMode === "TRAILING" ? Number(form.trailDrawdownPct) : 0,
      ...translationPayload(translation),
    },
  };
}

type FieldSetter = (
  key: TextKey,
) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;

function useRulesForm(link?: CopyLink) {
  const [form, setForm] = useState<RulesForm>(() => rulesDefaults(link));
  const [translation, setTranslation] = useState<TranslationForm>(() =>
    translationDefaults(link?.rules),
  );
  const set: FieldSetter = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggle = (key: BoolKey) => (value: boolean) => setForm((f) => ({ ...f, [key]: value }));
  const toggleDay = (day: number) =>
    setForm((f) => ({
      ...f,
      sessionDays: f.sessionDays.includes(day)
        ? f.sessionDays.filter((d) => d !== day)
        : [...f.sessionDays, day].sort(),
    }));
  return { form, set, toggle, toggleDay, translation, setTranslation };
}

const LOT_VALUE_LABEL: Record<Rules["lotMode"], { label: string; hint?: string }> = {
  FIXED: { label: "Lots per trade" },
  MULTIPLIER: { label: "Factor", hint: "The master's lot times this." },
  BALANCE: { label: "Factor", hint: "Applied on top of the scaling." },
  EQUITY: { label: "Factor", hint: "Applied on top of the scaling." },
  EQUITY_STEP: { label: "Lots per step", hint: "e.g. 0.01 lots for every step of equity below." },
  RISK_PERCENT: {
    label: "Risk per trade (% of equity)",
    hint: "Lost if the master's stop loss is hit. Trades without a stop loss are skipped.",
  },
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function RulesFields({
  form,
  set,
  toggle,
  toggleDay,
  translation,
  setTranslation,
  linkId,
  destinationSymbols,
}: {
  form: RulesForm;
  set: FieldSetter;
  toggle: (key: BoolKey) => (value: boolean) => void;
  toggleDay: (day: number) => void;
  translation: TranslationForm;
  setTranslation: (next: TranslationForm) => void;
  linkId: string | undefined;
  destinationSymbols: string[];
}) {
  const lotValue = LOT_VALUE_LABEL[form.lotMode];
  const peakExample = 50;
  const drawdown = Number(form.trailDrawdownPct) || 0;
  return (
    <>
      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">Lot sizing</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Mode"
            hint="Auto-scaling multiplies the master's lot by the ratio between the two accounts."
          >
            <select className={inputClass} value={form.lotMode} onChange={set("lotMode")}>
              <option value="BALANCE">Auto-scale by balance</option>
              <option value="EQUITY">Auto-scale by equity</option>
              <option value="EQUITY_STEP">Lots per equity step ($1,000 → 0.01)</option>
              <option value="RISK_PERCENT">Risk a % of equity at the master's SL</option>
              <option value="MULTIPLIER">Multiply the master's lot</option>
              <option value="FIXED">Fixed lot</option>
            </select>
          </Field>
          <Field label={lotValue.label} {...(lotValue.hint ? { hint: lotValue.hint } : {})}>
            <input
              required
              type="number"
              step="0.01"
              min="0.01"
              className={inputClass}
              value={form.lotValue}
              onChange={set("lotValue")}
            />
          </Field>
          {form.lotMode === "EQUITY_STEP" && (
            <Field
              label="Equity step"
              hint={`${form.lotValue || 0} lots per ${form.equityStep || 0} of slave equity, in whole steps.`}
            >
              <input
                required
                type="number"
                step="1"
                min="1"
                className={inputClass}
                value={form.equityStep}
                onChange={set("equityStep")}
              />
            </Field>
          )}
          <Field label="Maximum lots per order" hint="0 means no cap. Worth setting.">
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.maxLot}
              onChange={set("maxLot")}
            />
          </Field>
          <Field label="If the lot comes out under the symbol minimum">
            <select
              className={inputClass}
              value={form.minVolumeAction}
              onChange={set("minVolumeAction")}
            >
              <option value="SKIP">Skip the trade</option>
              <option value="MIN">Use the smallest allowed lot</option>
            </select>
          </Field>
        </div>
        <p className="text-[11px] break-words text-muted-foreground">
          Lots always round down to the symbol&apos;s step, so rounding never increases your
          exposure.
        </p>
      </fieldset>

      <SymbolTranslation
        form={translation}
        onChange={setTranslation}
        linkId={linkId}
        destinationSymbols={destinationSymbols}
      />

      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">Copy settings</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Slippage allowance (points)">
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxSlippagePoints}
              onChange={set("maxSlippagePoints")}
            />
          </Field>
        </div>
        <div className="space-y-2">
          <Toggle
            checked={form.copyExisting}
            onChange={toggle("copyExisting")}
            label="Copy trades already open on the master"
            hint="Off by default: it would enter at prices the master never paid."
          />
          <Toggle
            checked={form.reverse}
            onChange={toggle("reverse")}
            label="Reverse the direction"
            hint="Buys become sells. The master's stops are not copied, since they would sit on the wrong side."
          />
          <p className="text-[11px] break-words text-muted-foreground">
            Opens, closes and partial closes are always copied. A partial close shrinks the copy by
            the same share the master closed.
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">Risk limits</legend>
        <p className="text-[11px] break-words text-muted-foreground">
          0 or empty turns a limit off. Days and hours use the slave broker&apos;s server time, the
          clock its MT5 charts show. When a limit is reached, new trades are not copied, open copies
          are still managed, and you get one Telegram alert.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximum open copies">
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxOpenPositions}
              onChange={set("maxOpenPositions")}
            />
          </Field>
          <Field label="Maximum trades per day">
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxTradesPerDay}
              onChange={set("maxTradesPerDay")}
            />
          </Field>
          <Field label="Maximum BUY exposure (lots)">
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.maxBuyLots}
              onChange={set("maxBuyLots")}
            />
          </Field>
          <Field label="Maximum SELL exposure (lots)">
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={form.maxSellLots}
              onChange={set("maxSellLots")}
            />
          </Field>
          <Field label="Maximum daily loss" hint="Realized plus floating, since broker midnight.">
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.maxDailyLoss}
              onChange={set("maxDailyLoss")}
            />
          </Field>
          <Field
            label="Maximum consecutive losses"
            hint="Pauses copying until you resume the link."
          >
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxConsecutiveLosses}
              onChange={set("maxConsecutiveLosses")}
            />
          </Field>
          <Field
            label="Maximum loss per trade"
            hint="A copy losing this much is closed on the slave, even if the master stays open."
          >
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.maxLossPerTrade}
              onChange={set("maxLossPerTrade")}
            />
          </Field>
          <Field
            label="Stop if slave equity drops by (%)"
            hint="Closes this link's copies and stops it until you arm it again."
          >
            <input
              type="number"
              step="0.5"
              min="0"
              className={inputClass}
              value={form.maxDrawdownPct}
              onChange={set("maxDrawdownPct")}
            />
          </Field>
          <Field label="Trading session from" hint="Server time. Leave both empty for all day.">
            <input
              type="time"
              className={inputClass}
              value={form.sessionStart}
              onChange={set("sessionStart")}
            />
          </Field>
          <Field label="Trading session until" hint="An end before the start runs overnight.">
            <input
              type="time"
              className={inputClass}
              value={form.sessionEnd}
              onChange={set("sessionEnd")}
            />
          </Field>
        </div>
        <div>
          <p className="text-xs font-medium">Trading days</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {WEEKDAYS.map((name, day) => {
              const on = form.sessionDays.includes(day);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={on}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-xs font-medium",
                    on
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {form.sessionDays.length === 0
              ? "None selected: every day."
              : "Copying only on the highlighted days."}
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">Profit protection</legend>
        <Field
          label="How copies exit"
          hint="Pick one: two exit rules running at once would fight each other."
        >
          <select className={inputClass} value={form.exitMode} onChange={set("exitMode")}>
            <option value="MASTER">Follow the master&apos;s stop loss / take profit</option>
            <option value="TRAILING">Trail the profit on the slave</option>
          </select>
        </Field>
        {form.exitMode === "MASTER" ? (
          <div className="space-y-2">
            <Toggle
              checked={form.copySl}
              onChange={toggle("copySl")}
              label="Copy the stop loss"
              hint="Mirrors the master's SL, and moves it when the master trails it."
            />
            <Toggle
              checked={form.copyTp}
              onChange={toggle("copyTp")}
              label="Copy the take profit"
              hint="Mirrors the master's TP, and follows it when it moves."
            />
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Start trailing at a profit of" hint="Trailing is off below this.">
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  className={inputClass}
                  value={form.trailActivation}
                  onChange={set("trailActivation")}
                />
              </Field>
              <Field label="Give back at most (%)" hint="Of the highest profit reached.">
                <input
                  required
                  type="number"
                  step="1"
                  min="1"
                  max="99"
                  className={inputClass}
                  value={form.trailDrawdownPct}
                  onChange={set("trailDrawdownPct")}
                />
              </Field>
            </div>
            <p className="rounded-lg bg-background/60 p-2 text-[11px] break-words text-muted-foreground">
              Example: trailing starts once a copy is up {form.trailActivation || 0}. If it peaks at{" "}
              {peakExample}, it closes when profit falls to{" "}
              {(peakExample * (1 - drawdown / 100)).toFixed(2)} (giving back{" "}
              {((peakExample * drawdown) / 100).toFixed(2)}). The master&apos;s SL/TP are not
              copied; a master close still closes the copy.
            </p>
          </>
        )}
      </fieldset>
    </>
  );
}

/** Destination symbol names, for autocompleting a mapping's right-hand side. */
function useDestinationSymbols(accountId: string | undefined): string[] {
  const [symbols, setSymbols] = useState<string[]>([]);
  useEffect(() => {
    if (!accountId) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    api<{ symbols: string[] }>(`/api/copier/accounts/${accountId}/symbols`)
      .then((d) => {
        if (!cancelled) setSymbols(d.symbols);
      })
      // Autocomplete is a convenience; a destination whose terminal is still
      // starting simply offers no suggestions.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  return symbols;
}

function EditLinkForm({
  link,
  destAccountId,
  busy,
  onCancel,
  onSave,
}: {
  link: CopyLink;
  destAccountId: string | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const { form, set, toggle, toggleDay, translation, setTranslation } = useRulesForm(link);
  const [label, setLabel] = useState(link.label);
  const [problem, setProblem] = useState<string | null>(null);
  const destinationSymbols = useDestinationSymbols(destAccountId);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const bad = translationProblem(translation);
        if (bad) {
          setProblem(bad);
          return;
        }
        setProblem(null);
        onSave({ label, ...rulesPayload(form, translation) });
      }}
      className="mt-3 space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4"
    >
      <p className="text-[11px] break-words text-muted-foreground">
        The master and the destination cannot be changed here — that would be a different link.
        Create a new one for a different pair.
      </p>
      <Field label="Label">
        <input
          required
          className={inputClass}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <RulesFields
        form={form}
        set={set}
        toggle={toggle}
        toggleDay={toggleDay}
        translation={translation}
        setTranslation={setTranslation}
        linkId={link.id}
        destinationSymbols={destinationSymbols}
      />
      {problem && <p className="text-[11px] break-words text-destructive">{problem}</p>}
      {link.enabled && !link.dryRun && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] break-words text-amber-600 dark:text-amber-400">
          This link is live. New rules apply to trades from the moment you save; copies already open
          keep the size they were opened at.
        </p>
      )}
      <FormButtons busy={busy} onCancel={onCancel} submitLabel="Save changes" />
    </form>
  );
}

function LinkForm({
  accounts,
  brokers,
  onSave,
  onCancel,
  busy,
}: {
  accounts: Account[];
  brokers: Broker[];
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const destinations = accounts.filter((a) => a.role !== "MASTER");
  const terminalMasters = accounts.filter((a) => a.role !== "DESTINATION");
  const { form, set, toggle, toggleDay, translation, setTranslation } = useRulesForm();
  const [head, setHead] = useState({
    label: "",
    masterKind: "MANAGER" as Master["kind"],
    masterBrokerId: brokers[0]?.id ?? "",
    masterLogin: "",
    masterAccountId: terminalMasters[0]?.id ?? "",
    destAccountId: destinations[0]?.id ?? "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const createDestinationSymbols = useDestinationSymbols(head.destAccountId || undefined);
  const setHeadField =
    (key: keyof typeof head) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setHead((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const bad = translationProblem(translation);
        if (bad) {
          setProblem(bad);
          return;
        }
        setProblem(null);
        const payload = rulesPayload(form, translation);
        onSave({
          label: head.label,
          master:
            head.masterKind === "MANAGER"
              ? { kind: "MANAGER", brokerId: head.masterBrokerId, login: Number(head.masterLogin) }
              : { kind: "TERMINAL", accountId: head.masterAccountId },
          destAccountId: head.destAccountId,
          ...payload,
        });
      }}
      className="mt-3 space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4"
    >
      <Field label="Label">
        <input
          required
          className={inputClass}
          value={head.label}
          onChange={setHeadField("label")}
          placeholder="e.g. Signal account to Main slave"
        />
      </Field>

      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">
          Master — where trades are copied from
        </legend>
        <Field
          label="Read the master"
          hint="Through a broker's Manager connection is the normal choice: no password for that account, and nothing can trade on it."
        >
          <select
            className={inputClass}
            value={head.masterKind}
            onChange={setHeadField("masterKind")}
          >
            <option value="MANAGER">From the Manager connection (recommended)</option>
            <option value="TERMINAL">By logging in to the account on its MT5 server</option>
          </select>
        </Field>
        {head.masterKind === "MANAGER" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Broker" hint="Whose Manager connection can see the master.">
              <select
                required
                className={inputClass}
                value={head.masterBrokerId}
                onChange={setHeadField("masterBrokerId")}
              >
                <option value="">Choose a broker</option>
                {brokers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.server})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Master's MT5 login" hint="Read only. No password for it is needed.">
              <input
                required
                type="number"
                className={inputClass}
                value={head.masterLogin}
                onChange={setHeadField("masterLogin")}
                placeholder="e.g. 50001"
              />
            </Field>
          </div>
        ) : (
          <Field
            label="Master account"
            hint="An account added below. Its investor password is enough."
          >
            <select
              required
              className={inputClass}
              value={head.masterAccountId}
              onChange={setHeadField("masterAccountId")}
            >
              <option value="">Choose an account</option>
              {terminalMasters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.login})
                </option>
              ))}
            </select>
          </Field>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
        <legend className="px-1 text-xs font-semibold">
          Destination — where trades are copied to
        </legend>
        <Field label="Account" hint="Needs its MT5 trading password, on a hedging account.">
          <select
            required
            className={inputClass}
            value={head.destAccountId}
            onChange={setHeadField("destAccountId")}
          >
            <option value="">Choose an account</option>
            {destinations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.server} · {a.login})
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <RulesFields
        form={form}
        set={set}
        toggle={toggle}
        toggleDay={toggleDay}
        translation={translation}
        setTranslation={setTranslation}
        linkId={undefined}
        destinationSymbols={createDestinationSymbols}
      />
      {problem && <p className="text-[11px] break-words text-destructive">{problem}</p>}

      <FormButtons busy={busy} onCancel={onCancel} submitLabel="Create link" />
      <p className="text-[11px] break-words text-muted-foreground">
        The link is created stopped and in dry run. Start it, watch the activity log agree with what
        the master is doing, then switch it live.
      </p>
    </form>
  );
}
