import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Sliders,
  Trash2,
  User,
  UserCheck,
  Users,
  UserX,
  X,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import type { PublicUser, UserRole, UserStatus } from "@/server/user-store";

export const Route = createFileRoute("/admin/users/")({
  head: () => ({
    meta: [
      { title: "User Directory · MT5 Admin CRM" },
      { name: "description", content: "Manage users, permissions, limits, and approvals." },
    ],
  }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [actionError, setActionError] = useState<string | null>(null);

  // Modal for creating user
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("USER");
  const [newStatus, setNewStatus] = useState<UserStatus>("ACTIVE");
  const [creating, setCreating] = useState(false);

  const fetchUsers = async () => {
    try {
      setActionError(null);
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (roleFilter !== "ALL") params.set("role", roleFilter);

      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (res.status === 401 || res.status === 403) {
        await navigate({ to: "/" });
        return;
      }
      if (!res.ok) throw new Error("Failed to load users.");
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Error loading users.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [search, statusFilter, roleFilter]);

  const handleStatusChange = async (userId: string, status: UserStatus) => {
    try {
      setActionError(null);
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.message || "Failed to update user status.");
      }
      await fetchUsers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Status update error.");
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          username: newUsername,
          password: newPassword,
          role: newRole,
          status: newStatus,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to create user.");
      }
      setShowCreateModal(false);
      setNewName("");
      setNewEmail("");
      setNewUsername("");
      setNewPassword("");
      await fetchUsers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Create user failed.");
    } finally {
      setCreating(false);
    }
  };

  const statusBadge = (status: UserStatus) => {
    switch (status) {
      case "ACTIVE":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        );
      case "PENDING":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400 animate-pulse">
            <Clock className="size-3" />
            Pending Approval
          </span>
        );
      case "SUSPENDED":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs font-semibold text-destructive">
            <UserX className="size-3" />
            Suspended
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {status}
          </span>
        );
    }
  };

  return (
    <AdminShell
      title="User Directory & Management"
      subtitle="Control user accounts, authorizations, status, and permissions"
      right={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 transition-colors"
          >
            <Plus className="size-3.5" />
            <span>Add User</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              fetchUsers();
            }}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {actionError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <p>{actionError}</p>
          </div>
        )}

        {/* Filter and Search Bar */}
        <div className="panel p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          {/* Search box */}
          <div className="flex items-center gap-2 rounded-lg border border-input bg-secondary/60 px-3 py-1.5 sm:w-72">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search name, email, username…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Status Tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 text-xs font-medium">
            {["ALL", "ACTIVE", "PENDING", "SUSPENDED"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1 transition-colors capitalize ${
                  statusFilter === s
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.toLowerCase()}
              </button>
            ))}
          </div>

          {/* Role Filter */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Role:</span>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="rounded-lg border border-input bg-secondary px-2.5 py-1 text-xs font-medium outline-none"
            >
              <option value="ALL">All Roles</option>
              <option value="USER">User / Operator</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </div>
        </div>

        {/* Users Table */}
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Governance Limits</th>
                  <th className="px-4 py-3">Registered / Last Login</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Loading user directory…
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No users matched the criteria.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} className="hover:bg-muted/30 transition-colors">
                      {/* Name & Email */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="grid size-8 place-items-center rounded-full bg-primary/10 text-primary font-bold">
                            {user.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <Link
                              to="/admin/users/$id"
                              params={{ id: user.id }}
                              className="font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-1"
                            >
                              <span className="truncate">{user.name}</span>
                            </Link>
                            <p className="text-[11px] text-muted-foreground truncate font-mono">
                              {user.email} · @{user.username}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Role */}
                      <td className="px-4 py-3">
                        {user.role === "ADMIN" ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                            <Shield className="size-3" />
                            ADMIN
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                            <User className="size-3" />
                            USER
                          </span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">{statusBadge(user.status)}</td>

                      {/* Limits */}
                      <td className="px-4 py-3">
                        {user.role === "ADMIN" ? (
                          <span className="text-[11px] text-muted-foreground italic">
                            Admin (No MT5 limits)
                          </span>
                        ) : (
                          <div className="space-y-0.5 text-[11px] text-muted-foreground">
                            <p>
                              Brokers max:{" "}
                              <span className="font-semibold text-foreground">
                                {user.limits?.maxBrokers ?? 5}
                              </span>
                            </p>
                            <p>
                              Clients max:{" "}
                              <span className="font-semibold text-foreground">
                                {user.limits?.maxMonitoredClients ?? 25}
                              </span>
                            </p>
                          </div>
                        )}
                      </td>

                      {/* Created / Last Login */}
                      <td className="px-4 py-3 text-[11px] text-muted-foreground">
                        <p>Joined: {new Date(user.createdAt).toLocaleDateString()}</p>
                        <p>
                          Login:{" "}
                          {user.lastLoginAt
                            ? new Date(user.lastLoginAt).toLocaleDateString()
                            : "Never"}
                        </p>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Pending -> Approve */}
                          {user.status === "PENDING" && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(user.id, "ACTIVE")}
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-xs hover:bg-emerald-700 transition-colors"
                              title="Approve and activate user account"
                            >
                              <Check className="size-3" />
                              <span>Approve</span>
                            </button>
                          )}

                          {/* Active -> Suspend */}
                          {user.status === "ACTIVE" && user.role !== "ADMIN" && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(user.id, "SUSPENDED")}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                              title="Suspend user account"
                            >
                              <UserX className="size-3" />
                              <span>Suspend</span>
                            </button>
                          )}

                          {/* Suspended -> Reactivate */}
                          {user.status === "SUSPENDED" && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(user.id, "ACTIVE")}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 transition-colors"
                              title="Reactivate user account"
                            >
                              <UserCheck className="size-3" />
                              <span>Reactivate</span>
                            </button>
                          )}

                          {/* Manage / Profile */}
                          <Link
                            to="/admin/users/$id"
                            params={{ id: user.id }}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-secondary/80 transition-colors"
                            title="Manage permissions and limits"
                          >
                            <Sliders className="size-3" />
                            <span>Manage</span>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="panel w-full max-w-md p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
                  <UserCheck className="size-4" />
                </div>
                <h3 className="font-semibold text-sm">Add New User</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-3.5">
              <div className="space-y-1">
                <label className="label-xs">Full Name</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. John Doe"
                  className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="label-xs">Email Address</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="john@broker.com"
                  className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="label-xs">Username</label>
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="john_d"
                  className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="label-xs">Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="label-xs">Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="w-full rounded-lg border border-input bg-secondary px-2.5 py-2 text-xs outline-none"
                  >
                    <option value="USER">User / Operator</option>
                    <option value="ADMIN">Administrator</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="label-xs">Initial Status</label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value as UserStatus)}
                    className="w-full rounded-lg border border-input bg-secondary px-2.5 py-2 text-xs outline-none"
                  >
                    <option value="ACTIVE">Active (Approved)</option>
                    <option value="PENDING">Pending Approval</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {creating ? "Creating…" : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
