import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  History,
  Mail,
  RefreshCw,
  Shield,
  ShieldCheck,
  User,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import type { PublicUser } from "@/server/user-store";

export const Route = createFileRoute("/admin/approvals")({
  head: () => ({
    meta: [
      { title: "Pending Approvals · MT5 Admin CRM" },
      { name: "description", content: "Review and approve new user account registrations." },
    ],
  }),
  component: AdminApprovalsPage,
});

function AdminApprovalsPage() {
  const navigate = useNavigate();
  const [pendingUsers, setPendingUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchPending = async () => {
    try {
      setActionError(null);
      const res = await fetch("/api/admin/users?status=PENDING");
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: res.status === 403 ? "/dashboard" : "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load pending users.");
      const data = await res.json();
      setPendingUsers(data.users || []);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Error loading pending requests.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleAction = async (userId: string, status: "ACTIVE" | "SUSPENDED", userName: string) => {
    setProcessingId(userId);
    setActionError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to update user status.");
      }
      setSuccessMsg(
        status === "ACTIVE"
          ? `User "${userName}" has been approved and activated.`
          : `User "${userName}" was rejected and marked suspended.`,
      );
      await fetchPending();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Status update error.");
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <AdminShell
      title="Pending Approvals Queue"
      subtitle="Review new user registration requests and grant operator access"
      right={
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            fetchPending();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      }
    >
      <div className="space-y-4 max-w-4xl mx-auto">
        {actionError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <p>{actionError}</p>
          </div>
        )}

        {successMsg && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0" />
            <p>{successMsg}</p>
          </div>
        )}

        {/* Status summary banner */}
        <div className="flex items-center justify-between panel p-4 bg-card">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-amber-500/15 text-amber-500">
              <Clock className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">
                {pendingUsers.length} Pending Account Registration
                {pendingUsers.length === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-muted-foreground">
                Users registered through the portal cannot log in until approved below.
              </p>
            </div>
          </div>
          <Link to="/admin/users" className="text-xs font-medium text-primary hover:underline">
            All users →
          </Link>
        </div>

        {/* Cards Queue */}
        {loading ? (
          <div className="panel p-10 text-center text-xs text-muted-foreground">
            Loading approval queue…
          </div>
        ) : pendingUsers.length === 0 ? (
          <div className="panel p-12 text-center space-y-3">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-6" />
            </div>
            <h3 className="font-semibold text-sm">All Registrations Processed</h3>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              There are no user accounts pending approval at this time. New registrations submitted
              via the sign-in portal will appear here automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pendingUsers.map((user) => {
              const isProcessing = processingId === user.id;
              return (
                <div
                  key={user.id}
                  className="panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-amber-500/30 transition-colors"
                >
                  <div className="flex items-start gap-3.5">
                    <div className="grid size-10 place-items-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 font-bold shrink-0">
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-foreground">{user.name}</span>
                        <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                          PENDING
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1 font-mono">
                          <Mail className="size-3" /> {user.email}
                        </span>
                        <span className="flex items-center gap-1 font-mono">
                          <User className="size-3" /> @{user.username}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" /> Registered{" "}
                          {new Date(user.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Default Limits: {user.limits?.maxBrokers ?? 5} Brokers ·{" "}
                        {user.limits?.maxMonitoredClients ?? 25} Monitored Clients
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-border">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => handleAction(user.id, "ACTIVE", user.name)}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    >
                      <Check className="size-3.5" />
                      <span>{isProcessing ? "Processing…" : "Approve Access"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => handleAction(user.id, "SUSPENDED", user.name)}
                      className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                    >
                      <UserX className="size-3.5" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
