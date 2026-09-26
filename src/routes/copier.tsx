import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { cn } from "@/lib/utils";

type Account = {
  id: string;
  label: string;
  broker: string;
  server: string;
  login: number;
};

type Broker = {
  id: string;
  name: string;
  server: string;
  status: string;
};

type Rules = {
  lotMode: "FIXED" | "MULTIPLIER" | "BALANCE" | "EQUITY";
  lotValue: number;
  maxLot: number;
  minVolumeAction: "SKIP" | "MIN";
  symbolSuffix: string;
  reverse: boolean;
  copySlTp: boolean;
  copyExisting: boolean;
  maxOpenPositions: number;
  maxSlippagePoints: number;
};

type LinkStatus = {
  state: {
    copiedPositions: number;
    copiedCount: number;
    haltedReason: string | null;
  };
  cycle: {
    error?: string | null;
    masterPositions?: number;
    masterEquity?: number;
    destEquity?: number;
  };
};

type CopyLink = {
  id: string;
  label: string;
  masterBrokerId: string;
  masterLogin: number;
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

const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "That did not work.");
  return data as T;
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] break-words text-muted-foreground">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

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
  const [addingLink, setAddingLink] = useState(false);
  const [probe, setProbe] = useState<Record<string, Snapshot | string>>({});

  const load = useCallback(async () => {
    const data = await api<{
      accounts: Account[];
      brokers: Broker[];
      links: CopyLink[];
      events: CopierEvent[];
      service: { running: boolean; error: string | null };
    }>("/api/copier");
    setAccounts(data.accounts);
    setBrokers(data.brokers);
    setLinks(data.links);
    setEvents(data.events);
    setService(data.service);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 5000);
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
        {service.error && (
          <div className="flex flex-wrap items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">
              The copier service is not responding, so nothing is being copied right now.{" "}
              {service.error}
            </p>
          </div>
        )}
        {error && (
          <div className="flex flex-wrap items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{error}</p>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs break-words text-primary">
            {notice}
          </div>
        )}

        {/* ---------------- accounts ---------------- */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Destination accounts</h2>
              <p className="text-xs break-words text-muted-foreground">
                The accounts trades are copied onto. Each needs its MT5 trading password; an
                investor password cannot place orders. Masters are read through your broker's
                Manager connection, so they are not set up here.
              </p>
            </div>
            <button
              onClick={() => setAddingAccount((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground"
            >
              <Plus className="size-3.5" /> Add account
            </button>
          </div>

          {addingAccount && (
            <AccountForm
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
              busy={busy === "add-account"}
            />
          )}

          <div className="mt-3 space-y-2">
            {accounts.length === 0 && !addingAccount && (
              <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                No destination accounts yet. Add the account you want trades copied onto.
              </p>
            )}
            {accounts.map((account) => {
              const result = probe[account.id];
              return (
                <div
                  key={account.id}
                  className="rounded-xl border border-border bg-secondary/40 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-semibold break-words">{account.label}</p>
                      <p className="text-xs break-all text-muted-foreground">
                        {account.broker ? `${account.broker} · ` : ""}
                        {account.server} · {account.login}
                      </p>
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                      <button
                        onClick={() =>
                          run(`probe-${account.id}`, async () => {
                            try {
                              const snap = await api<Snapshot>(
                                `/api/copier/accounts/${account.id}/probe`,
                                { method: "POST" },
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
                        disabled={busy === `probe-${account.id}`}
                        className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary disabled:opacity-50"
                      >
                        {busy === `probe-${account.id}` ? "Checking..." : "Test login"}
                      </button>
                      <button
                        onClick={() => {
                          if (!confirm(`Remove ${account.label}?`)) return;
                          void run(
                            `del-${account.id}`,
                            () => api(`/api/copier/accounts/${account.id}`, { method: "DELETE" }),
                            "Account removed.",
                          );
                        }}
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
                        <span className="font-semibold">{result.account.name}</span> ·{" "}
                        {result.account.company}
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
            })}
          </div>
        </Card>

        {/* ---------------- links ---------------- */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Copy links</h2>
              <p className="text-xs break-words text-muted-foreground">
                Each link copies one master account onto one destination. New links start stopped
                and in dry run.
              </p>
            </div>
            <button
              onClick={() => setAddingLink((v) => !v)}
              disabled={accounts.length < 1 || brokers.length < 1}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground disabled:opacity-50"
            >
              <Plus className="size-3.5" /> Add link
            </button>
          </div>

          {addingLink && (
            <LinkForm
              accounts={accounts}
              brokers={brokers}
              onCancel={() => setAddingLink(false)}
              busy={busy === "add-link"}
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

          <div className="mt-3 space-y-3">
            {links.length === 0 && !addingLink && (
              <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                No links yet.
              </p>
            )}
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                masterBroker={brokerById(link.masterBrokerId)}
                dest={accountById(link.destAccountId)}
                busy={busy}
                onAction={run}
              />
            ))}
          </div>
        </Card>

        {/* ---------------- activity ---------------- */}
        <Card>
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <div className="mt-2 space-y-1.5">
            {events.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing yet. Decisions appear here as soon as a link is running, including in dry
                run.
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

function eventTone(kind: string): "ok" | "warn" | "danger" | "muted" {
  if (kind === "opened" || kind === "open") return "ok";
  if (kind === "error" || kind === "halted") return "danger";
  if (kind === "skipped" || kind === "duplicate") return "warn";
  return "muted";
}

function Tag({ tone, text }: { tone: "ok" | "warn" | "danger" | "muted"; text: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        tone === "ok" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        tone === "danger" && "bg-destructive/15 text-destructive",
        tone === "muted" && "bg-secondary text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

function LinkRow({
  link,
  masterBroker,
  dest,
  busy,
  onAction,
}: {
  link: CopyLink;
  masterBroker: Broker | undefined;
  dest: Account | undefined;
  busy: string | null;
  onAction: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const halted = link.status?.state.haltedReason ?? null;
  const cycleError = link.status?.cycle.error ?? null;
  const patch = (body: Record<string, unknown>, done?: string) =>
    onAction(
      `link-${link.id}`,
      () => api(`/api/copier/links/${link.id}`, { method: "PATCH", body: JSON.stringify(body) }),
      done,
    );

  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-semibold break-words">{link.label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs break-words text-muted-foreground">
            <span>
              {masterBroker ? `${masterBroker.name} ${link.masterLogin}` : "unknown broker"}
            </span>
            <ArrowRight className="size-3 shrink-0" />
            <span>{dest ? `${dest.label} (${dest.login})` : "unknown destination"}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Tag tone={link.enabled ? "ok" : "muted"} text={link.enabled ? "running" : "stopped"} />
            <Tag tone={link.dryRun ? "warn" : "danger"} text={link.dryRun ? "dry run" : "LIVE"} />
            <Tag
              tone="muted"
              text={
                link.rules.lotMode === "FIXED"
                  ? `${link.rules.lotValue} lots fixed`
                  : link.rules.lotMode === "MULTIPLIER"
                    ? `x${link.rules.lotValue}`
                    : `by ${link.rules.lotMode.toLowerCase()} x${link.rules.lotValue}`
              }
            />
            {link.rules.maxLot > 0 && <Tag tone="muted" text={`max ${link.rules.maxLot}`} />}
            {link.rules.reverse && <Tag tone="warn" text="reversed" />}
            {link.maxDrawdownPct > 0 && (
              <Tag tone="muted" text={`stop at -${link.maxDrawdownPct}%`} />
            )}
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
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
              if (!confirm(`Close every position this link owns on the destination?`)) return;
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
      {!halted && cycleError && (
        <p className="mt-2 rounded-lg bg-amber-500/10 p-2 text-[11px] break-words text-amber-600 dark:text-amber-400">
          {cycleError}
        </p>
      )}
      {link.status && (
        <p className="mt-2 text-[11px] break-words text-muted-foreground">
          {link.status.state.copiedPositions} open{" "}
          {link.status.state.copiedPositions === 1 ? "copy" : "copies"} ·{" "}
          {link.status.state.copiedCount} copied in total · {link.status.cycle.masterPositions ?? 0}{" "}
          open on the master
        </p>
      )}
    </div>
  );
}

function AccountForm({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [form, setForm] = useState({
    label: "",
    broker: "",
    server: "",
    login: "",
    password: "",
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
            placeholder="Master — TD Capital"
          />
        </Field>
        <Field label="Broker" hint="Optional, for your own reference.">
          <input
            className={inputClass}
            value={form.broker}
            onChange={set("broker")}
            placeholder="TD Capital"
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
            placeholder="WyncrestCapital-Trade"
          />
        </Field>
        <Field label="MT5 login">
          <input
            required
            type="number"
            className={inputClass}
            value={form.login}
            onChange={set("login")}
            placeholder="910102"
          />
        </Field>
        <Field
          label="Password"
          hint="A destination needs the trading password. An investor password can only read."
        >
          <input
            required
            type="password"
            className={inputClass}
            value={form.password}
            onChange={set("password")}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save account"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium whitespace-nowrap"
        >
          Cancel
        </button>
      </div>
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
  const [form, setForm] = useState({
    label: "",
    masterBrokerId: brokers[0]?.id ?? "",
    masterLogin: "",
    destAccountId: accounts[0]?.id ?? "",
    lotMode: "BALANCE" as Rules["lotMode"],
    lotValue: "1",
    maxLot: "0",
    minVolumeAction: "SKIP" as Rules["minVolumeAction"],
    symbolSuffix: "",
    maxOpenPositions: "0",
    maxDrawdownPct: "0",
    reverse: false,
    copySlTp: true,
    copyExisting: false,
  });
  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [key]:
          e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value,
      }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          label: form.label,
          masterBrokerId: form.masterBrokerId,
          masterLogin: Number(form.masterLogin),
          destAccountId: form.destAccountId,
          maxDrawdownPct: Number(form.maxDrawdownPct),
          rules: {
            lotMode: form.lotMode,
            lotValue: Number(form.lotValue),
            maxLot: Number(form.maxLot),
            minVolumeAction: form.minVolumeAction,
            symbolSuffix: form.symbolSuffix,
            maxOpenPositions: Number(form.maxOpenPositions),
            reverse: form.reverse,
            copySlTp: form.copySlTp,
            copyExisting: form.copyExisting,
          },
        });
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
            placeholder="TD Capital to Wyncrest"
          />
        </Field>
        <Field
          label="Master's broker"
          hint="The broker whose Manager connection can see the master account."
        >
          <select
            required
            className={inputClass}
            value={form.masterBrokerId}
            onChange={set("masterBrokerId")}
          >
            <option value="">Choose a broker</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.server})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Master's MT5 login"
          hint="Read only, over the Manager API. No password for this account is needed."
        >
          <input
            required
            type="number"
            className={inputClass}
            value={form.masterLogin}
            onChange={set("masterLogin")}
            placeholder="100003"
          />
        </Field>
        <Field label="Copy onto (destination)">
          <select
            required
            className={inputClass}
            value={form.destAccountId}
            onChange={set("destAccountId")}
          >
            <option value="">Choose an account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.login})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Lot sizing"
          hint="Balance scales the master's lot by the ratio of the two balances."
        >
          <select className={inputClass} value={form.lotMode} onChange={set("lotMode")}>
            <option value="BALANCE">Scale by balance</option>
            <option value="EQUITY">Scale by equity</option>
            <option value="MULTIPLIER">Multiply the master's lot</option>
            <option value="FIXED">Fixed lot</option>
          </select>
        </Field>
        <Field
          label={form.lotMode === "FIXED" ? "Lots per trade" : "Factor"}
          hint={form.lotMode === "FIXED" ? undefined : "Applied on top of the scaling above."}
        >
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
        <Field
          label="Destination symbol suffix"
          hint="Only needed when one base name matches several symbols, e.g. .s"
        >
          <input
            className={inputClass}
            value={form.symbolSuffix}
            onChange={set("symbolSuffix")}
            placeholder=".s"
          />
        </Field>
        <Field label="If the lot is under the minimum">
          <select
            className={inputClass}
            value={form.minVolumeAction}
            onChange={set("minVolumeAction")}
          >
            <option value="SKIP">Skip the trade</option>
            <option value="MIN">Use the smallest allowed lot</option>
          </select>
        </Field>
        <Field label="Maximum open copies" hint="0 means no cap.">
          <input
            type="number"
            min="0"
            className={inputClass}
            value={form.maxOpenPositions}
            onChange={set("maxOpenPositions")}
          />
        </Field>
        <Field
          label="Stop if equity drops by (%)"
          hint="0 is off. When it fires, the link closes its copies and stays stopped."
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
      </div>

      <div className="space-y-2">
        {(
          [
            ["copySlTp", "Copy stop loss and take profit", "Mirrors the master's levels."],
            ["reverse", "Reverse the direction", "Buys become sells. Stops are not copied."],
            [
              "copyExisting",
              "Copy trades already open on the master",
              "Off by default: it would enter at prices the master never paid.",
            ],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="flex items-start gap-2.5 text-xs">
            <input
              type="checkbox"
              checked={form[key] as boolean}
              onChange={set(key)}
              className="mt-0.5 size-4 shrink-0"
            />
            <span className="min-w-0">
              <span className="font-medium">{label}</span>
              <span className="block break-words text-[11px] text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving..." : "Create link"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium whitespace-nowrap"
        >
          Cancel
        </button>
      </div>
      <p className="flex flex-wrap items-start gap-1.5 text-[11px] text-muted-foreground">
        <Copy className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 break-words">
          The link is created stopped and in dry run. Start it, watch the activity log agree with
          what the master is doing, then switch it live.
        </span>
      </p>
    </form>
  );
}
