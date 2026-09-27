import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldAlert,
  Trash2,
  X,
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
  lotMode: "FIXED" | "MULTIPLIER" | "BALANCE" | "EQUITY";
  lotValue: number;
  maxLot: number;
  minVolumeAction: "SKIP" | "MIN";
  symbolSuffix: string;
  symbolMap: Record<string, string>;
  allowSymbols: string[];
  denySymbols: string[];
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
    ignored: number;
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
  const [addingLink, setAddingLink] = useState(false);
  const [editingLink, setEditingLink] = useState<string | null>(null);
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

          <div className="mt-3 space-y-3">
            {links.length === 0 && !addingLink && (
              <Empty>
                {accounts.length === 0
                  ? "Add a destination account below, then create your first link."
                  : "No links yet."}
              </Empty>
            )}
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                masterLabel={masterLabel(link.master)}
                dest={accountById(link.destAccountId)}
                busy={busy}
                onAction={run}
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
              <AccountRow
                key={account.id}
                account={account}
                result={probe[account.id]}
                busy={busy}
                onProbe={() =>
                  run(`probe-${account.id}`, async () => {
                    try {
                      const snap = await api<Snapshot>(`/api/copier/accounts/${account.id}/probe`, {
                        method: "POST",
                      });
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
                onDelete={() => {
                  if (!confirm(`Remove ${account.label}?`)) return;
                  void run(
                    `del-${account.id}`,
                    () => api(`/api/copier/accounts/${account.id}`, { method: "DELETE" }),
                    "Account removed.",
                  );
                }}
              />
            ))}
          </div>
        </Card>

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
  busy,
  onProbe,
  onDelete,
}: {
  account: Account;
  result: Snapshot | string | undefined;
  busy: string | null;
  onProbe: () => void;
  onDelete: () => void;
}) {
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
          </div>
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
  editing,
  onToggleEdit,
  onSaveEdit,
}: {
  link: CopyLink;
  masterLabel: string;
  dest: Account | undefined;
  busy: string | null;
  onAction: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
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
            {!rules.copySlTp && <Tag tone="muted" text="no SL/TP" />}
            {rules.maxOpenPositions > 0 && (
              <Tag tone="muted" text={`max ${rules.maxOpenPositions} open`} />
            )}
            {link.maxDrawdownPct > 0 && (
              <Tag tone="muted" text={`stop at -${link.maxDrawdownPct}%`} />
            )}
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
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
      {!halted && cycleError && (
        <p className="mt-2 rounded-lg bg-amber-500/10 p-2 text-[11px] break-words text-amber-600 dark:text-amber-400">
          {cycleError}
        </p>
      )}
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
    role: "DESTINATION" as Role,
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
            placeholder="Slave — Wyncrest"
          />
        </Field>
        <Field label="Broker" hint="Optional, for your own reference.">
          <input
            className={inputClass}
            value={form.broker}
            onChange={set("broker")}
            placeholder="Wyncrest Capital"
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
          hint="A destination needs the trading password. A master read by login only needs its investor password."
        >
          <input
            required
            type="password"
            className={inputClass}
            value={form.password}
            onChange={set("password")}
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
      <FormButtons busy={busy} onCancel={onCancel} submitLabel="Save account" />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rules, shared by the create and edit forms so the two cannot drift apart.
// ---------------------------------------------------------------------------

type RulesForm = {
  lotMode: Rules["lotMode"];
  lotValue: string;
  maxLot: string;
  minVolumeAction: Rules["minVolumeAction"];
  maxOpenPositions: string;
  maxSlippagePoints: string;
  maxDrawdownPct: string;
  reverse: boolean;
  copySlTp: boolean;
  copyExisting: boolean;
};

function rulesDefaults(link?: CopyLink): RulesForm {
  const r = link?.rules;
  return {
    lotMode: r?.lotMode ?? "BALANCE",
    lotValue: String(r?.lotValue ?? 1),
    maxLot: String(r?.maxLot ?? 0),
    minVolumeAction: r?.minVolumeAction ?? "SKIP",
    maxOpenPositions: String(r?.maxOpenPositions ?? 0),
    maxSlippagePoints: String(r?.maxSlippagePoints ?? 20),
    maxDrawdownPct: String(link?.maxDrawdownPct ?? 0),
    reverse: r?.reverse ?? false,
    copySlTp: r?.copySlTp ?? true,
    copyExisting: r?.copyExisting ?? false,
  };
}

function rulesPayload(form: RulesForm, translation: TranslationForm) {
  return {
    maxDrawdownPct: Number(form.maxDrawdownPct),
    rules: {
      lotMode: form.lotMode,
      lotValue: Number(form.lotValue),
      maxLot: Number(form.maxLot),
      minVolumeAction: form.minVolumeAction,
      maxOpenPositions: Number(form.maxOpenPositions),
      maxSlippagePoints: Number(form.maxSlippagePoints),
      reverse: form.reverse,
      copySlTp: form.copySlTp,
      copyExisting: form.copyExisting,
      ...translationPayload(translation),
    },
  };
}

type FieldSetter = (
  key: keyof RulesForm,
) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;

function useRulesForm(link?: CopyLink) {
  const [form, setForm] = useState<RulesForm>(() => rulesDefaults(link));
  const [translation, setTranslation] = useState<TranslationForm>(() =>
    translationDefaults(link?.rules),
  );
  const set: FieldSetter = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggle = (key: keyof RulesForm) => (value: boolean) =>
    setForm((f) => ({ ...f, [key]: value }));
  return { form, set, toggle, translation, setTranslation };
}

function RulesFields({
  form,
  set,
  toggle,
  translation,
  setTranslation,
  linkId,
  destinationSymbols,
}: {
  form: RulesForm;
  set: FieldSetter;
  toggle: (key: keyof RulesForm) => (value: boolean) => void;
  translation: TranslationForm;
  setTranslation: (next: TranslationForm) => void;
  linkId: string | undefined;
  destinationSymbols: string[];
}) {
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
              <option value="MULTIPLIER">Multiply the master's lot</option>
              <option value="FIXED">Fixed lot</option>
            </select>
          </Field>
          <Field
            label={form.lotMode === "FIXED" ? "Lots per trade" : "Factor"}
            {...(form.lotMode === "FIXED" ? {} : { hint: "Applied on top of the scaling above." })}
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
        <legend className="px-1 text-xs font-semibold">Limits and behaviour</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximum open copies" hint="0 means no cap.">
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxOpenPositions}
              onChange={set("maxOpenPositions")}
            />
          </Field>
          <Field label="Slippage allowance (points)">
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.maxSlippagePoints}
              onChange={set("maxSlippagePoints")}
            />
          </Field>
          <Field
            label="Stop if destination equity drops by (%)"
            hint="0 is off. When it fires, the link closes its copies and stays stopped until you arm it."
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
          <Toggle
            checked={form.copySlTp}
            onChange={toggle("copySlTp")}
            label="Copy stop loss and take profit"
            hint="Mirrors the master's levels, and follows them when they move."
          />
          <Toggle
            checked={form.reverse}
            onChange={toggle("reverse")}
            label="Reverse the direction"
            hint="Buys become sells. The master's stops are not copied, since they would sit on the wrong side."
          />
          <Toggle
            checked={form.copyExisting}
            onChange={toggle("copyExisting")}
            label="Copy trades already open on the master"
            hint="Off by default: it would enter at prices the master never paid."
          />
        </div>
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
  const { form, set, toggle, translation, setTranslation } = useRulesForm(link);
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
  const { form, set, toggle, translation, setTranslation } = useRulesForm();
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
          placeholder="TDFX 100003 to Wyncrest 910102"
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
                placeholder="100003"
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
