import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Activity, Eye, Fingerprint, Lock, Mail, ShieldCheck } from "lucide-react";
import { store } from "@/lib/app-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sign in · MT5 Client Live Monitor" },
      {
        name: "description",
        content:
          "Secure sign-in for MT5 Client Live Monitor — a read-only broker operations platform for watching client accounts and live positions.",
      },
      { property: "og:title", content: "Sign in · MT5 Client Live Monitor" },
      {
        property: "og:description",
        content: "Read-only MT5 broker operations monitoring for client accounts and positions.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signIn = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        user?: { name?: string };
        message?: string;
      };
      if (!response.ok || !payload.user) {
        throw new Error(payload.message || "Unable to sign in.");
      }
      store.signIn(payload.user.name);
      await navigate({ to: "/dashboard" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-background px-5 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary">
            <Activity className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              MT5 Client Live Monitor
            </h1>
            <p className="text-xs text-muted-foreground">Broker operations · read-only</p>
          </div>
        </div>

        <form
          className="panel mt-8 space-y-4 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            await signIn();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="email" className="label-xs">
              Email or username
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <input
                id="email"
                type="text"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                placeholder="you@company.com"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="label-xs">
              Password
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
              <Lock className="size-4 shrink-0 text-muted-foreground" />
              <input
                id="password"
                type={show ? "text" : "password"}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide password" : "Show password"}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Eye className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" defaultChecked className="size-4 accent-[var(--primary)]" />
              Remember me
            </label>
            <button type="button" className="text-sm font-medium text-primary hover:underline">
              Forgot password
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity active:opacity-90"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          <button
            type="button"
            onClick={() =>
              setError("Passkey sign-in is not configured yet. Use your account credentials.")
            }
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Fingerprint className="size-4" /> Use passkey
          </button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Encrypted session · no trading actions available
        </p>
      </div>
    </div>
  );
}
