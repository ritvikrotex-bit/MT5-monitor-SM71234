import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  Database,
  Key,
  Lock,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useApp } from "@/lib/app-store";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({
    meta: [
      { title: "System & Safety · MT5 Admin CRM" },
      {
        name: "description",
        content: "System governance, safety verification, and platform configuration.",
      },
    ],
  }),
  component: AdminSettingsPage,
});

function AdminSettingsPage() {
  const currentUser = useApp((s) => s.user);

  return (
    <AdminShell
      title="System Governance & Safety Verification"
      subtitle="Security architecture, read-only guarantees, and administrative configuration"
    >
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Read-Only Safety Model Certificate */}
        <div className="panel p-6 border-emerald-500/30 bg-emerald-500/5 space-y-4">
          <div className="flex items-start gap-4">
            <div className="grid size-12 place-items-center rounded-2xl bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 shrink-0">
              <ShieldCheck className="size-7" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-foreground">
                  Read-Only Architecture & Safety Guarantee
                </h2>
                <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  ACTIVE
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                MT5 Client Live Monitor is engineered strictly for read-only broker operations and
                client oversight. Under no circumstances can this platform place orders, modify open
                trades, adjust stop losses, or close positions.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 pt-2">
            <div className="rounded-lg border border-border/80 bg-background/80 p-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span>Zero Execution Code</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                No trading order functions (`OrderSend`, `PositionClose`, etc.) exist in the
                codebase.
              </p>
            </div>

            <div className="rounded-lg border border-border/80 bg-background/80 p-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span>Admin Decoupled</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The Admin CRM never connects to MT5 servers on its own behalf.
              </p>
            </div>

            <div className="rounded-lg border border-border/80 bg-background/80 p-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span>Audit Isolation</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                All administrative and security actions are permanently written to an immutable log.
              </p>
            </div>
          </div>
        </div>

        {/* Security & Authentication Policies */}
        <div className="panel p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-border">
            <Lock className="size-4 text-primary" />
            <h3 className="font-bold text-sm">Security & Secret Protection Policies</h3>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-start gap-3">
              <div className="grid size-6 place-items-center rounded bg-secondary text-primary shrink-0 mt-0.5">
                <Key className="size-3.5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Cryptographic Password Hashing</p>
                <p className="text-muted-foreground mt-0.5">
                  Passwords are encrypted using Node.js native salted `scryptSync` (64-byte key
                  length). Passwords are never stored in plaintext and never committed to source
                  code repositories.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="grid size-6 place-items-center rounded bg-secondary text-primary shrink-0 mt-0.5">
                <Shield className="size-3.5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">HMAC-SHA256 Signed Sessions</p>
                <p className="text-muted-foreground mt-0.5">
                  Web sessions are signed with server-side HMAC SHA-256 tokens in `HttpOnly` and
                  `SameSite=Lax` cookies, with automatic live database validation on every request.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="grid size-6 place-items-center rounded bg-secondary text-primary shrink-0 mt-0.5">
                <Database className="size-3.5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Automated Secret Redaction in Logs</p>
                <p className="text-muted-foreground mt-0.5">
                  The audit logger automatically scrubs sensitive parameters (passwords, bot tokens,
                  api keys, authorization headers) before persisting entries to disk.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* System Runtime Overview */}
        <div className="panel p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-border">
            <Server className="size-4 text-primary" />
            <h3 className="font-bold text-sm">Runtime Configuration</h3>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <div className="rounded-lg border border-border bg-secondary/50 p-3 space-y-1">
              <span className="label-xs text-muted-foreground">Admin Account</span>
              <p className="font-mono font-semibold text-foreground">
                {currentUser?.email || "admin@system.local"}
              </p>
              <p className="text-[10px] text-muted-foreground">Role: Primary Administrator</p>
            </div>

            <div className="rounded-lg border border-border bg-secondary/50 p-3 space-y-1">
              <span className="label-xs text-muted-foreground">Data Storage Location</span>
              <p className="font-mono font-semibold text-foreground">
                PostgreSQL / Local Encrypted Store
              </p>
              <p className="text-[10px] text-muted-foreground">Production Database (Gitignored)</p>
            </div>

            <div className="rounded-lg border border-border bg-secondary/50 p-3 space-y-1">
              <span className="label-xs text-muted-foreground">Connector Client</span>
              <p className="font-mono font-semibold text-foreground">http://127.0.0.1:8765</p>
              <p className="text-[10px] text-muted-foreground">MetaTrader 5 Native Connector</p>
            </div>

            <div className="rounded-lg border border-border bg-secondary/50 p-3 space-y-1">
              <span className="label-xs text-muted-foreground">Application Engine</span>
              <p className="font-mono font-semibold text-foreground">TanStack Start · Vite</p>
              <p className="text-[10px] text-muted-foreground">Full-stack React framework</p>
            </div>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
