import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Lock,
  Mail,
  Radar,
  RefreshCw,
  Save,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  User,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import type { PublicUser, UserPermissions, UserLimits, UserStatus } from "@/server/user-store";

export const Route = createFileRoute("/admin/users/$id")({
  head: () => ({
    meta: [
      { title: "User CRM Profile · MT5 Admin" },
      { name: "description", content: "Inspect user profile, permissions, limits, and brokers." },
    ],
  }),
  component: UserDetailPage,
});

type UserDetailData = {
  user: PublicUser;
  brokers: Array<{
    id: string;
    name: string;
    server: string;
    managerLogin: string;
    status: string;
    createdAt: string;
  }>;
  monitored: Array<{
    brokerId: string;
    login: number;
    clientName?: string;
    createdAt: string;
  }>;
};

function UserDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const [data, setData] = useState<UserDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable Permissions State
  const [permissions, setPermissions] = useState<UserPermissions>({
    canLogin: true,
    canAddBroker: true,
    canConnectBroker: true,
    canMonitorClients: true,
    canUseTelegram: true,
    canUseEmail: true,
    canUsePush: true,
  });

  // Editable Limits State
  const [limits, setLimits] = useState<UserLimits>({
    maxBrokers: 5,
    maxMonitoredClients: 25,
  });

  const fetchUserDetails = async () => {
    try {
      setError(null);
      const res = await fetch(`/api/admin/users/${id}`);
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load user profile.");
      const json = await res.json();
      setData(json);
      if (json.user?.permissions) {
        setPermissions(json.user.permissions);
      }
      if (json.user?.limits) {
        setLimits(json.user.limits);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading user.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchUserDetails();
  }, [id]);

  const handleStatusChange = async (status: UserStatus) => {
    try {
      setError(null);
      setMessage(null);
      const res = await fetch(`/api/admin/users/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.message || "Status update failed.");
      }
      setMessage(`User status successfully updated to ${status}.`);
      await fetchUserDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status update error.");
    }
  };

  const handleSaveGovernance = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      // 1. Save Permissions
      const permRes = await fetch(`/api/admin/users/${id}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions }),
      });
      if (!permRes.ok) {
        const p = await permRes.json().catch(() => ({}));
        throw new Error(p.message || "Failed to update permissions.");
      }

      // 2. Save Limits
      const limRes = await fetch(`/api/admin/users/${id}/limits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits }),
      });
      if (!limRes.ok) {
        const l = await limRes.json().catch(() => ({}));
        throw new Error(l.message || "Failed to update limits.");
      }

      setMessage("User permissions and limits successfully updated.");
      await fetchUserDetails();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving governance settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!window.confirm("Are you sure you want to deactivate and delete this user?")) return;
    try {
      setError(null);
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        throw new Error(p.message || "Delete failed.");
      }
      await navigate({ to: "/admin/users" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error deleting user.");
    }
  };

  const togglePermission = (key: keyof UserPermissions) => {
    setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) {
    return (
      <AdminShell title="User Profile">
        <div className="panel p-10 text-center text-xs text-muted-foreground">
          Loading user details…
        </div>
      </AdminShell>
    );
  }

  if (!data?.user) {
    return (
      <AdminShell title="User Not Found">
        <div className="panel p-10 text-center space-y-3">
          <p className="text-sm font-semibold">User account not found.</p>
          <Link to="/admin/users" className="text-xs text-primary hover:underline">
            ← Return to user directory
          </Link>
        </div>
      </AdminShell>
    );
  }

  const user = data.user;

  return (
    <AdminShell
      title={`User: ${user.name}`}
      subtitle={`CRM Profile · ID: ${user.id}`}
      right={
        <Link
          to="/admin/users"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          <span>Back to Users</span>
        </Link>
      }
    >
      <div className="space-y-6 max-w-5xl mx-auto">
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {message && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4 shrink-0" />
            <p>{message}</p>
          </div>
        )}

        {/* User Profile Card */}
        <div className="panel p-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-border">
            <div className="flex items-start gap-4">
              <div className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary text-xl font-bold">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-bold text-foreground">{user.name}</h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                      user.role === "ADMIN"
                        ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                        : "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    }`}
                  >
                    {user.role}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      user.status === "ACTIVE"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : user.status === "PENDING"
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 animate-pulse"
                          : "bg-destructive/15 text-destructive"
                    }`}
                  >
                    {user.status}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{user.email}</span>
                  <span className="font-mono">@{user.username}</span>
                  <span>Registered: {new Date(user.createdAt).toLocaleDateString()}</span>
                  {user.approvedAt && <span>Approved by: {user.approvedBy || "Admin"}</span>}
                </div>
              </div>
            </div>

            {/* Quick Status Transitions */}
            <div className="flex items-center gap-2">
              {user.status === "PENDING" && (
                <button
                  type="button"
                  onClick={() => handleStatusChange("ACTIVE")}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition-colors"
                >
                  <Check className="size-3.5" />
                  <span>Approve User</span>
                </button>
              )}
              {user.status === "ACTIVE" && user.role !== "ADMIN" && (
                <button
                  type="button"
                  onClick={() => handleStatusChange("SUSPENDED")}
                  className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
                >
                  <UserX className="size-3.5" />
                  <span>Suspend Account</span>
                </button>
              )}
              {user.status === "SUSPENDED" && (
                <button
                  type="button"
                  onClick={() => handleStatusChange("ACTIVE")}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                >
                  <UserCheck className="size-3.5" />
                  <span>Reactivate Account</span>
                </button>
              )}
              {user.role !== "ADMIN" && (
                <button
                  type="button"
                  onClick={handleDeleteUser}
                  className="rounded-lg border border-border p-2 text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
                  title="Soft delete user"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          </div>

          {/* Governance Permissions and Limits Settings */}
          {user.role === "USER" && (
            <div className="mt-6 space-y-6">
              {/* Permission Switches */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-bold text-foreground">Access Permissions</h3>
                    <p className="text-xs text-muted-foreground">
                      Enable or restrict feature access for this operator.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveGovernance}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    <Save className="size-3.5" />
                    <span>{saving ? "Saving…" : "Save Changes"}</span>
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    {
                      key: "canLogin",
                      label: "Allow Login Access",
                      desc: "User can authenticate and access platform",
                    },
                    {
                      key: "canAddBroker",
                      label: "Add New MT5 Brokers",
                      desc: "User can configure new broker servers",
                    },
                    {
                      key: "canConnectBroker",
                      label: "Connect Brokers",
                      desc: "User can activate MT5 broker sessions",
                    },
                    {
                      key: "canMonitorClients",
                      label: "Monitor Client Accounts",
                      desc: "User can track client accounts & positions",
                    },
                    {
                      key: "canUseTelegram",
                      label: "Telegram Notifications",
                      desc: "User can enable bot alerts",
                    },
                    {
                      key: "canUseEmail",
                      label: "Email Notifications",
                      desc: "User can receive email notifications",
                    },
                    {
                      key: "canUsePush",
                      label: "Browser Push Alerts",
                      desc: "User can receive push messages",
                    },
                  ].map((item) => {
                    const active = permissions[item.key as keyof UserPermissions];
                    return (
                      <div
                        key={item.key}
                        onClick={() => togglePermission(item.key as keyof UserPermissions)}
                        className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 cursor-pointer transition-colors ${
                          active
                            ? "border-primary/40 bg-primary/5"
                            : "border-border bg-secondary/40 opacity-70"
                        }`}
                      >
                        <div className="space-y-0.5 min-w-0">
                          <p className="text-xs font-semibold text-foreground">{item.label}</p>
                          <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                        </div>
                        <div
                          className={`size-5 shrink-0 rounded-md border flex items-center justify-center transition-colors ${
                            active
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-border bg-background"
                          }`}
                        >
                          {active && <Check className="size-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Limits Configuration */}
              <div className="pt-4 border-t border-border">
                <h3 className="text-sm font-bold text-foreground mb-1">Operational Limits</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Maximum volume thresholds assigned to this operator.
                </p>

                <div className="grid gap-4 sm:grid-cols-2 max-w-lg">
                  <div className="space-y-1.5">
                    <label className="label-xs">Max Configured Brokers</label>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={limits.maxBrokers}
                      onChange={(e) =>
                        setLimits((prev) => ({
                          ...prev,
                          maxBrokers: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                        }))
                      }
                      className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs font-mono font-semibold outline-none"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Currently using {data.brokers.length} / {limits.maxBrokers}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="label-xs">Max Monitored Client Accounts</label>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      value={limits.maxMonitoredClients}
                      onChange={(e) =>
                        setLimits((prev) => ({
                          ...prev,
                          maxMonitoredClients: Math.max(
                            0,
                            Number.parseInt(e.target.value, 10) || 0,
                          ),
                        }))
                      }
                      className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs font-mono font-semibold outline-none"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Currently monitoring {data.monitored.length} / {limits.maxMonitoredClients}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* User Configured Brokers Grid */}
        <div className="panel p-5">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div>
              <h3 className="text-sm font-bold text-foreground">User's MT5 Brokers</h3>
              <p className="text-xs text-muted-foreground">
                Brokers added by this operator (Read-only view)
              </p>
            </div>
            <span className="label-xs">{data.brokers.length} configured</span>
          </div>

          <div className="mt-3">
            {data.brokers.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No brokers configured by this user yet.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.brokers.map((b) => (
                  <div key={b.id} className="flex items-center justify-between py-3 text-xs">
                    <div className="flex items-center gap-3">
                      <div className="grid size-8 place-items-center rounded-lg bg-blue-500/10 text-blue-500">
                        <Building2 className="size-4" />
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">{b.name}</p>
                        <p className="text-[11px] text-muted-foreground font-mono">
                          {b.server} · Login: {b.managerLogin}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                        b.status === "CONNECTED"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {b.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* User Monitored Accounts Grid */}
        <div className="panel p-5">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div>
              <h3 className="text-sm font-bold text-foreground">User's Monitored Clients</h3>
              <p className="text-xs text-muted-foreground">
                Live client accounts actively watched by this user
              </p>
            </div>
            <span className="label-xs">{data.monitored.length} watched</span>
          </div>

          <div className="mt-3">
            {data.monitored.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No client accounts currently monitored by this user.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.monitored.map((m) => (
                  <div
                    key={`${m.brokerId}-${m.login}`}
                    className="flex items-center justify-between py-3 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className="grid size-8 place-items-center rounded-lg bg-purple-500/10 text-purple-500">
                        <Radar className="size-4" />
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">
                          Account #{m.login} {m.clientName ? `· ${m.clientName}` : ""}
                        </p>
                        <p className="text-[11px] text-muted-foreground font-mono">
                          Broker ID: {m.brokerId}
                        </p>
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      Monitored since {new Date(m.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
