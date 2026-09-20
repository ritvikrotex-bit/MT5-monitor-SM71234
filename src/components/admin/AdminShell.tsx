import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRightLeft,
  Building2,
  CheckCircle2,
  Clock,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Settings,
  Shield,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/mt5/ThemeToggle";
import { cn } from "@/lib/utils";
import { store, useApp } from "@/lib/app-store";

const adminNav = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/admin/users", label: "User Directory", icon: Users, exact: false },
  {
    to: "/admin/approvals",
    label: "Pending Approvals",
    icon: Clock,
    exact: false,
    badgeKey: "pending",
  },
  { to: "/admin/brokers", label: "Broker Oversight", icon: Building2, exact: false },
  { to: "/admin/monitored", label: "Monitored Clients", icon: Radar, exact: false },
  { to: "/admin/logs", label: "Audit Trail", icon: History, exact: false },
  { to: "/admin/settings", label: "System & Safety", icon: Settings, exact: false },
] as const;

export function AdminShell({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentUser = useApp((s) => s.user);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (!active) return;
        if (!res.ok) {
          await navigate({ to: "/" });
          return;
        }
        const data = await res.json();
        if (data?.user?.role !== "ADMIN") {
          await navigate({ to: "/dashboard" });
          return;
        }
        store.setUser(data.user);
      } catch {
        // Network error: keep the shell; the admin API calls will surface the problem.
      }
    })();
    return () => {
      active = false;
    };
  }, [navigate]);

  useEffect(() => {
    let active = true;
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/admin/stats");
        if (res.ok) {
          const data = await res.json();
          if (active && data?.users?.pending !== undefined) {
            setPendingCount(data.users.pending);
          }
        }
      } catch {
        // Stats are only a badge count; ignore transient errors.
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {
      // Sign out locally even if the request failed.
    }
    store.signOut();
    await navigate({ to: "/" });
  };

  const isNavActive = (item: (typeof adminNav)[number]) => {
    if (item.exact) return pathname === item.to || pathname === `${item.to}/`;
    return pathname.startsWith(item.to);
  };

  return (
    <div className="min-h-screen bg-background lg:flex">
      {/* Desktop Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        {/* CRM Branding */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border/60">
          <div className="grid size-9 place-items-center rounded-xl bg-amber-500/20 text-amber-500">
            <Shield className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-bold tracking-tight">MT5 CRM</span>
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">
                ADMIN
              </span>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">Governance & Oversight</p>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 space-y-1.5 px-3 py-4 overflow-y-auto">
          <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Governance Menu
          </div>
          {adminNav.map((item) => {
            const active = isNavActive(item);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.to === "/admin/approvals" && pendingCount > 0 && (
                  <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white shadow-xs">
                    {pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Sidebar Footer */}
        <div className="space-y-3 border-t border-sidebar-border p-4 bg-sidebar/50">
          {/* Read-only Safety Indicator */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
            <div className="flex items-center gap-1.5 font-semibold">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span>Read-Only Safety</span>
            </div>
            <p className="mt-0.5 opacity-90 leading-relaxed">
              Admin panel cannot place trades, close orders, or alter MT5 trading state.
            </p>
          </div>

          {/* Switch to Client View */}
          <Link
            to="/dashboard"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary/80 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowRightLeft className="size-3.5" />
            <span>Switch to Client Monitor</span>
          </Link>

          {/* User Account / Logout */}
          <div className="flex items-center justify-between pt-1">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-foreground">
                {currentUser?.name || "Administrator"}
              </p>
              <p className="truncate text-[10px] text-muted-foreground">
                {currentUser?.email || "admin@system.local"}
              </p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              title="Sign out"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Header */}
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="grid size-9 place-items-center rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground lg:hidden"
                aria-label="Open navigation"
              >
                <Menu className="size-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-bold tracking-tight sm:text-xl">{title}</h1>
                {subtitle && (
                  <div className="truncate text-xs text-muted-foreground mt-0.5">{subtitle}</div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {/* Quick Status Pill */}
              <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                <span>Governance Engine Live</span>
              </div>

              {right}
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Page Body */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative flex w-72 max-w-[80vw] flex-col bg-sidebar p-5 text-sidebar-foreground shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-sidebar-border">
              <div className="flex items-center gap-2.5">
                <div className="grid size-8 place-items-center rounded-lg bg-amber-500/20 text-amber-500">
                  <Shield className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-bold">MT5 CRM</p>
                  <p className="text-[10px] text-muted-foreground">Admin Governance</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            </div>

            <nav className="flex-1 space-y-1.5 py-4 overflow-y-auto">
              {adminNav.map((item) => {
                const active = isNavActive(item);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                      active
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                    {item.to === "/admin/approvals" && pendingCount > 0 && (
                      <span className="ml-auto rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
                        {pendingCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            <div className="space-y-2 border-t border-sidebar-border pt-4">
              <Link
                to="/dashboard"
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary py-2 text-xs font-medium"
              >
                <ArrowRightLeft className="size-3.5" />
                <span>Client Monitor View</span>
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 py-2 text-xs font-medium text-destructive hover:bg-destructive/20"
              >
                <LogOut className="size-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
