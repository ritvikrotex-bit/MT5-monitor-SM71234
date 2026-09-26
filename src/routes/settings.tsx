import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bell, Mail, MessageCircle, Palette, ShieldCheck, Smartphone } from "lucide-react";
import { ThemeSegmented } from "@/components/mt5/ThemeToggle";
import { AppShell } from "@/components/mt5/AppShell";
import { ReadOnlyBadge } from "@/components/mt5/primitives";
import { store, useAppState } from "@/lib/app-store";
import { notificationMeta, type NotificationType } from "@/lib/mt5-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · MT5 Client Live Monitor" },
      {
        name: "description",
        content:
          "Configure notification delivery channels and event preferences for the MT5 Client Live Monitor.",
      },
      { property: "og:title", content: "Settings · MT5 Client Live Monitor" },
      {
        property: "og:description",
        content: "Notification channels and alert preferences for monitored MT5 clients.",
      },
    ],
  }),
  component: SettingsPage,
});

const eventOrder: NotificationType[] = [
  "new_position",
  "position_closed",
  "position_modified",
  "sl_modified",
  "tp_modified",
];

function SettingsPage() {
  const s = useAppState();
  // Telegram is per user. An administrator can switch it off for an account (canUseTelegram).
  const telegramAllowed = s.user?.permissions?.["canUseTelegram"] !== false;
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [showTelegramForm, setShowTelegramForm] = useState(false);
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [removingTelegram, setRemovingTelegram] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void fetch("/api/notifications")
      .then((response) => response.json())
      .then((payload) => {
        setTelegramConfigured(Boolean(payload.telegramConfigured));
        if (payload.chatId) setChatId(String(payload.chatId));
      })
      .catch(() => setTelegramConfigured(false));
  }, []);

  const handleSaveTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken.trim() || !chatId.trim() || savingTelegram) return;
    setSavingTelegram(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim(), chatId: chatId.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        setTelegramConfigured(true);
        setTestResult({
          ok: true,
          message: data.message || "Telegram bot configured and test message sent successfully!",
        });
        setShowTelegramForm(false);
        setBotToken("");
      } else {
        setTestResult({
          ok: false,
          message: data.message || data.error || "Failed to configure Telegram bot.",
        });
      }
    } catch {
      setTestResult({ ok: false, message: "Network error saving Telegram settings." });
    } finally {
      setSavingTelegram(false);
    }
  };

  const handleRemoveTelegram = async () => {
    if (
      removingTelegram ||
      !window.confirm("Disconnect Telegram? You will stop receiving alerts there.")
    )
      return;
    setRemovingTelegram(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications", { method: "DELETE" });
      if (res.ok) {
        setTelegramConfigured(false);
        setChatId("");
        setBotToken("");
        setShowTelegramForm(false);
        setTestResult({ ok: true, message: "Telegram disconnected." });
      } else {
        setTestResult({ ok: false, message: "Could not disconnect Telegram." });
      }
    } catch {
      setTestResult({ ok: false, message: "Network error reaching server." });
    } finally {
      setRemovingTelegram(false);
    }
  };

  const handleTestTelegram = async () => {
    if (testingTelegram) return;
    setTestingTelegram(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        setTestResult({ ok: true, message: data.message || "Test message delivered to Telegram!" });
      } else {
        setTestResult({
          ok: false,
          message: data.message || data.error || "Failed to send Telegram test message.",
        });
      }
    } catch {
      setTestResult({ ok: false, message: "Network error reaching server." });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/session", { method: "DELETE" });
    } finally {
      store.signOut();
      await navigate({ to: "/", replace: true });
    }
  };

  return (
    <AppShell
      title="Settings"
      subtitle="Notification channels and alert preferences"
      right={<ReadOnlyBadge className="hidden sm:inline-flex" />}
    >
      <section className="panel enter mt-4 p-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary">
            <Palette className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Appearance</h2>
            <p className="text-xs text-muted-foreground">Switch between light and dark theme</p>
          </div>
        </div>
        <div className="mt-4">
          <ThemeSegmented />
        </div>
      </section>

      <section className="panel enter mt-4 p-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary">
            <Smartphone className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Delivery channels</h2>
            <p className="text-xs text-muted-foreground">Choose how you receive alerts</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <ChannelRow
            icon={Bell}
            label="Push notifications"
            description="Browser and device alerts in real time"
            active={s.pushEnabled}
            onToggle={() => store.setPush(!s.pushEnabled)}
          />
          <div className="space-y-2">
            <ChannelRow
              icon={MessageCircle}
              label="Telegram"
              description={
                telegramConfigured
                  ? chatId
                    ? `Connected to Chat ID: ${chatId}`
                    : "Configured securely on server"
                  : telegramAllowed
                    ? "Add your own Telegram bot to receive alerts for your monitored clients"
                    : "Telegram alerts are disabled for your account — contact your administrator"
              }
              active={telegramConfigured}
              action={
                !telegramAllowed ? null : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowTelegramForm((prev) => !prev)}
                      className="rounded-lg border border-border bg-secondary px-2.5 py-1 text-xs font-medium hover:bg-accent"
                    >
                      {showTelegramForm ? "Cancel" : telegramConfigured ? "Edit" : "Configure"}
                    </button>
                    {telegramConfigured && (
                      <button
                        type="button"
                        onClick={handleTestTelegram}
                        disabled={testingTelegram}
                        className="rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
                      >
                        {testingTelegram ? "Sending..." : "Test Bot"}
                      </button>
                    )}
                    {telegramConfigured && (
                      <button
                        type="button"
                        onClick={handleRemoveTelegram}
                        disabled={removingTelegram}
                        className="rounded-lg border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        {removingTelegram ? "Removing..." : "Disconnect"}
                      </button>
                    )}
                  </div>
                )
              }
            />
            {telegramAllowed && showTelegramForm && (
              <form
                onSubmit={handleSaveTelegram}
                className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3"
              >
                <h3 className="text-xs font-semibold tracking-wide uppercase text-primary">
                  {telegramConfigured ? "Update Telegram Configuration" : "Configure Telegram Bot"}
                </h3>
                <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>
                    In Telegram open <span className="font-mono text-foreground">@BotFather</span>,
                    send <span className="font-mono text-foreground">/newbot</span> and copy the
                    <b> bot token</b> it gives you.
                  </li>
                  <li>
                    Add your bot to the group or channel that should get alerts (or open a chat with
                    it and press Start), then send any message there.
                  </li>
                  <li>
                    Get the <b>chat ID</b>: message{" "}
                    <span className="font-mono text-foreground">@userinfobot</span> for a private
                    chat, or for a group open{" "}
                    <span className="font-mono text-foreground">
                      https://api.telegram.org/bot&lt;token&gt;/getUpdates
                    </span>{" "}
                    and copy <span className="font-mono">chat.id</span> (groups start with{" "}
                    <span className="font-mono">-</span>).
                  </li>
                  <li>Paste both below. A test message is sent before anything is saved.</li>
                </ol>
                <p className="text-xs text-muted-foreground">
                  Alerts for <b>your</b> monitored clients go only to <b>your</b> chat. Other users
                  cannot see it.
                </p>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Telegram Bot Token</label>
                  <input
                    type="password"
                    autoComplete="off"
                    required
                    placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    className="w-full rounded-lg border border-input bg-secondary/80 px-3 py-2 text-xs font-mono outline-none focus:border-primary"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Chat ID / Channel Handle</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 987654321 or -1001234567890"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    className="w-full rounded-lg border border-input bg-secondary/80 px-3 py-2 text-xs font-mono outline-none focus:border-primary"
                  />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={savingTelegram}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {savingTelegram ? "Saving & Testing..." : "Save & Test Connection"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTelegramForm(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {testResult && (
              <p
                role="status"
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs",
                  testResult.ok
                    ? "border-positive/40 bg-positive/10 text-positive"
                    : "border-destructive/40 bg-destructive/10 text-destructive",
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>
          <ChannelRow
            icon={Mail}
            label="Email alerts"
            description="Digest and instant email summaries"
            active={s.emailAlerts}
            onToggle={() => store.setEmailAlerts(!s.emailAlerts)}
          />
        </div>
      </section>

      <section className="panel enter mt-4 p-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary">
            <Bell className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Event preferences</h2>
            <p className="text-xs text-muted-foreground">Toggle alert types you want to receive</p>
          </div>
        </div>

        <div className="mt-4 divide-y divide-border">
          {eventOrder.map((key) => {
            const meta = notificationMeta[key];
            const enabled = s.events[key];
            return (
              <div
                key={key}
                className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{meta.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {key === "new_position" && "When a monitored client opens a trade"}
                    {key === "position_closed" && "When a monitored client closes a trade"}
                    {key === "position_modified" && "Volume or partial close changes"}
                    {key === "sl_modified" && "Stop-loss level updates"}
                    {key === "tp_modified" && "Take-profit level updates"}
                  </p>
                </div>
                <Switch checked={enabled} onChange={() => store.setEvent(key, !enabled)} />
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel enter mt-4 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Read-only monitoring</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This application is strictly observational. It cannot open, close, modify or execute
              trades on any MT5 account.
            </p>
          </div>
        </div>
      </section>

      <div className="mt-6">
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="w-full rounded-lg border border-border bg-secondary py-3 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          MT5 Client Live Monitor · v1.0.0
        </p>
      </div>
    </AppShell>
  );
}

function ChannelRow({
  icon: Icon,
  label,
  description,
  active,
  onToggle,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  active: boolean;
  onToggle?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg transition-colors",
            active ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs break-words text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 pl-12 sm:w-auto sm:justify-end sm:pl-0 [&_button]:whitespace-nowrap">
        {action}
        {onToggle ? (
          <Switch checked={active} onChange={onToggle} />
        ) : (
          <span
            className={cn(
              "text-xs font-semibold",
              active ? "text-positive" : "text-muted-foreground",
            )}
          >
            {active ? "Connected" : "Setup needed"}
          </span>
        )}
      </div>
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-primary/45 bg-primary" : "border-border bg-secondary",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-card shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
