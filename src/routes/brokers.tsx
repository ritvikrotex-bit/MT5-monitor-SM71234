import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Check, Plus, Power, RefreshCw, X } from "lucide-react";
import { AppShell } from "@/components/mt5/AppShell";
import { ReadOnlyBadge, StatusDot } from "@/components/mt5/primitives";
import { cn } from "@/lib/utils";

import { store, useApp } from "@/lib/app-store";

type Broker = {
  id: string;
  name: string;
  server: string;
  managerLogin: string;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "ERROR";
  statusMessage: string;
  updatedAt: string;
};
const status = (value: Broker["status"]): "connected" | "connecting" | "disconnected" | "error" =>
  value === "CONNECTED"
    ? "connected"
    : value === "CONNECTING" || value === "RECONNECTING"
      ? "connecting"
      : value === "ERROR"
        ? "error"
        : "disconnected";

export const Route = createFileRoute("/brokers")({ component: BrokersPage });

function BrokersPage() {
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [adding, setAdding] = useState(false);
  const activeId = useApp((s) => s.activeBrokerId);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const response = await fetch("/api/brokers");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Unable to load saved brokers.");
    const list = (data.brokers || []) as Broker[];
    setBrokers(list);
    store.setBrokers(
      list.map((b) => ({
        id: b.id,
        name: b.name,
        server: b.server,
        status: status(b.status),
        managerLogin: b.managerLogin,
        lastUpdate: "now",
      })),
    );
  };

  useEffect(() => {
    load().catch((reason) =>
      setError(reason instanceof Error ? reason.message : "Unable to load saved brokers."),
    );
  }, []);

  const test = async (id: string) => {
    setError(null);
    const response = await fetch(`/api/brokers/${id}/test-connection`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) setError(data.message || "Connection test failed.");
    await load();
  };

  return (
    <AppShell
      title="Brokers"
      subtitle={`${brokers.length} saved broker connection${brokers.length === 1 ? "" : "s"}`}
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        All connected brokers are monitored simultaneously in the background 24/7. Setting a focus
        broker only changes your quick-view on the dashboard.
      </p>
      <div className="mt-4 space-y-3">
        {brokers.map((broker) => (
          <article
            key={broker.id}
            className={cn(
              "panel enter p-4",
              activeId === broker.id && "border-primary/40 bg-primary/5",
            )}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">{broker.name}</h2>
                <p className="num truncate text-xs text-muted-foreground">{broker.server}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <StatusDot status={status(broker.status)} />
                  <span className="num text-xs text-muted-foreground">
                    Manager {broker.managerLogin}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{broker.statusMessage}</p>
              </div>
              {activeId === broker.id ? (
                <button
                  type="button"
                  onClick={() => store.selectBroker(null)}
                  title="Clear dashboard focus"
                  className="inline-flex h-fit items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-semibold text-primary transition-all hover:bg-primary/25"
                >
                  <Check className="size-3.5" />
                  <span>Dashboard Focus</span>
                  <span className="text-[10px] font-normal opacity-75">· Clear</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => store.selectBroker(broker.id)}
                  title="Set as dashboard focus"
                  className="inline-flex h-fit items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                >
                  <span>Set Focus</span>
                </button>
              )}
            </div>
            <div className="mt-4 flex justify-end border-t border-border pt-3">
              <button
                onClick={() => void test(broker.id)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="size-3.5" /> Test connection
              </button>
            </div>
          </article>
        ))}
      </div>
      {adding ? (
        <AddBrokerForm
          onDone={async () => {
            setAdding(false);
            await load();
          }}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-4 text-sm font-medium text-muted-foreground"
        >
          <Plus className="size-4" /> Add broker connection
        </button>
      )}
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Building2 className="size-3.5" /> Saved connections use read-only Manager sessions
      </p>
    </AppShell>
  );
}

function AddBrokerForm({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [managerLogin, setManagerLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const login = managerLogin.trim();
    if (!name.trim() || !server.trim() || !login || !password)
      throw new Error("Broker name, MT5 server, Manager login and password are required.");
    if (!/^\d+$/.test(login))
      throw new Error("Manager login must be a numeric MT5 Manager account ID.");
    const created = await fetch("/api/brokers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        server: server.trim(),
        managerLogin: login,
        password,
      }),
    });
    const data = await created.json().catch(() => ({}));
    if (!created.ok) throw new Error(data.message || "Unable to save broker.");
    const tested = await fetch(`/api/brokers/${data.broker.id}/test-connection`, {
      method: "POST",
    });
    const testedData = await tested.json().catch(() => ({}));
    if (!tested.ok)
      throw new Error(testedData.message || "Broker was saved, but connection testing failed.");
  };
  return (
    <form
      className="panel enter mt-4 space-y-3 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await submit();
          await onDone();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Unable to save broker.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="flex justify-between">
        <h2 className="text-sm font-semibold">Add broker connection</h2>
        <button type="button" onClick={() => history.back()} aria-label="Cancel">
          <X className="size-4" />
        </button>
      </div>
      <Field label="Broker name" value={name} set={setName} placeholder="Wyncrest" />
      <Field label="MT5 server" value={server} set={setServer} placeholder="server:443" />
      <Field
        label="Numeric Manager login"
        value={managerLogin}
        set={setManagerLogin}
        placeholder="1001"
        inputMode="numeric"
      />
      <Field
        label="Manager password"
        value={password}
        set={setPassword}
        placeholder="••••••••"
        type="password"
      />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <button
        disabled={saving}
        className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground"
      >
        {saving ? "Testing connection…" : "Save and test connection"}
      </button>
    </form>
  );
}
function Field({
  label,
  value,
  set,
  placeholder,
  type = "text",
  inputMode,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  placeholder: string;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className="block space-y-1.5">
      <span className="label-xs">{label}</span>
      <input
        required
        value={value}
        type={type}
        inputMode={inputMode}
        onChange={(event) => set(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-input bg-secondary/60 px-3 py-2.5 text-sm outline-none"
      />
    </label>
  );
}
