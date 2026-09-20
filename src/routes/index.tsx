import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Fingerprint,
  Lock,
  Mail,
  Shield,
  ShieldAlert,
  ShieldCheck,
  User,
  UserPlus,
} from "lucide-react";
import { store, type UserProfile } from "@/lib/app-store";

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

type AuthMode = "user-login" | "admin-login" | "signup";

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("user-login");
  const [show, setShow] = useState(false);

  // Login form state
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  // Signup form state
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupUsername, setSignupUsername] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetMessages = () => {
    setError(null);
    setErrorCode(null);
    setSuccessMessage(null);
  };

  const signIn = async () => {
    resetMessages();
    setSubmitting(true);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier,
          password,
          role: mode === "admin-login" ? "ADMIN" : "USER",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        user?: UserProfile;
        redirect?: string;
        error?: string;
        message?: string;
      };

      if (!response.ok || !payload.user) {
        setErrorCode(payload.error || "UNAUTHORIZED");
        throw new Error(payload.message || "Unable to sign in.");
      }

      store.signIn(payload.user.name, payload.user);

      if (payload.redirect) {
        await navigate({ to: payload.redirect as "/admin" | "/dashboard" });
      } else if (payload.user.role === "ADMIN") {
        await navigate({ to: "/admin" });
      } else {
        await navigate({ to: "/dashboard" });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignup = async () => {
    resetMessages();
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: signupName,
          email: signupEmail,
          username: signupUsername,
          password: signupPassword,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        error?: string;
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.message || "Failed to create account.");
      }

      setSuccessMessage(
        payload.message ||
          "Your account has been created and is awaiting administrator approval. You will be able to log in once an administrator approves your account.",
      );
      setMode("user-login");
      setIdentifier(signupEmail);
      setPassword("");
      setSignupPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to register.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-background px-5 py-10">
      <div className="mx-auto w-full max-w-md">
        {/* Header Branding */}
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary">
            <Activity className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              MT5 Client Live Monitor
            </h1>
            <p className="text-xs text-muted-foreground">
              Broker operations · read-only safety model
            </p>
          </div>
        </div>

        {/* Dual Mode Switcher Tabs */}
        <div className="mt-8 grid grid-cols-2 gap-1 rounded-xl bg-secondary/80 p-1 text-sm font-medium">
          <button
            type="button"
            onClick={() => {
              setMode("user-login");
              resetMessages();
            }}
            className={`flex items-center justify-center gap-2 rounded-lg py-2 transition-all ${
              mode === "user-login"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <User className="size-4" />
            <span>Client Login</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("admin-login");
              resetMessages();
            }}
            className={`flex items-center justify-center gap-2 rounded-lg py-2 transition-all ${
              mode === "admin-login"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Shield className="size-4 text-amber-500" />
            <span>Admin Portal</span>
          </button>
        </div>

        {/* Card Panel */}
        <div className="panel mt-4 space-y-4 p-6">
          {mode === "admin-login" && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              <div className="flex items-center gap-2 font-medium">
                <Shield className="size-4" />
                <span>Central CRM & Governance Access</span>
              </div>
              <p className="mt-1 opacity-90">
                Log in to review user approvals, manage permissions, enforce broker limits, and
                audit platform activities.
              </p>
            </div>
          )}

          {successMessage && (
            <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Registration Submitted</p>
                <p className="mt-0.5">{successMessage}</p>
              </div>
            </div>
          )}

          {errorCode === "ACCOUNT_PENDING" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
              <Clock className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Account Pending Approval</p>
                <p className="mt-0.5">
                  Your account registration has been submitted and is currently awaiting
                  administrator review. An admin must activate your account before you can log in.
                </p>
              </div>
            </div>
          )}

          {errorCode === "ACCOUNT_SUSPENDED" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <ShieldAlert className="size-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Account Suspended</p>
                <p className="mt-0.5">
                  Your account has been suspended by an administrator. Please reach out to your
                  operations lead or administrator for assistance.
                </p>
              </div>
            </div>
          )}

          {error && errorCode !== "ACCOUNT_PENDING" && errorCode !== "ACCOUNT_SUSPENDED" && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {mode === "signup" ? (
            /* Signup Form */
            <form
              className="space-y-3.5"
              onSubmit={async (e) => {
                e.preventDefault();
                await handleSignup();
              }}
            >
              <div>
                <h2 className="text-sm font-semibold">Request Operator Access</h2>
                <p className="text-xs text-muted-foreground">
                  New accounts require administrator approval before access is granted.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="name" className="label-xs">
                  Full Name
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
                  <User className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    id="name"
                    type="text"
                    required
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="e.g. Alex Miller"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-email" className="label-xs">
                  Email Address
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
                  <Mail className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    id="signup-email"
                    type="email"
                    required
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="alex@company.com"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-username" className="label-xs">
                  Desired Username
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
                  <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    id="signup-username"
                    type="text"
                    required
                    value={signupUsername}
                    onChange={(e) => setSignupUsername(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="alex_m"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-password" className="label-xs">
                  Password
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
                  <Lock className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    id="signup-password"
                    type={show ? "text" : "password"}
                    required
                    minLength={6}
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="Min 6 characters"
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

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity active:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Submitting request…" : "Submit Access Request"}
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setMode("user-login");
                    resetMessages();
                  }}
                  className="text-xs text-primary hover:underline font-medium"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </form>
          ) : (
            /* Login Form */
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                await signIn();
              }}
            >
              <div className="space-y-1.5">
                <label htmlFor="identifier" className="label-xs">
                  {mode === "admin-login" ? "Admin Email or Username" : "Email or Username"}
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3">
                  <Mail className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    id="identifier"
                    type="text"
                    required
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder={
                      mode === "admin-login" ? "admin@yourdomain.com" : "operator@yourdomain.com"
                    }
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
                  <input
                    type="checkbox"
                    defaultChecked
                    className="size-4 accent-[var(--primary)]"
                  />
                  Remember me
                </label>
                {mode === "user-login" && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signup");
                      resetMessages();
                    }}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Request access
                  </button>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className={`w-full rounded-lg py-3 text-sm font-semibold transition-opacity active:opacity-90 disabled:opacity-50 ${
                  mode === "admin-login"
                    ? "bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                    : "bg-primary text-primary-foreground"
                }`}
              >
                {submitting
                  ? "Verifying credentials…"
                  : mode === "admin-login"
                    ? "Sign in to Admin CRM"
                    : "Sign in to Monitor"}
              </button>

              {mode === "user-login" && (
                <button
                  type="button"
                  onClick={() =>
                    setError("Passkey sign-in is not configured yet. Use your account credentials.")
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Fingerprint className="size-4" /> Use passkey
                </button>
              )}
            </form>
          )}
        </div>

        {/* Footer info */}
        <div className="mt-6 space-y-1 text-center">
          <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-emerald-500" /> Read-only MT5 integration · no
            trade placement or modification
          </p>
          {mode === "admin-login" && (
            <p className="text-[11px] text-muted-foreground/80">
              Admin actions are permanently logged in an append-only audit trail.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
