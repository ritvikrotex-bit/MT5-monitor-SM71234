import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Building2,
  Home,
  Search,
  Settings,
  Radar,
  Activity,
  ShieldCheck,
  Shield,
} from "lucide-react";
import { ThemeToggle } from "@/components/mt5/ThemeToggle";
import { cn } from "@/lib/utils";
import { brokerName, useApp, useHydrateBrokers, useHydrateSession } from "@/lib/app-store";

const nav = [
  { to: "/dashboard", label: "Home", desktopLabel: "Dashboard", icon: Home },
  { to: "/brokers", label: "Brokers", desktopLabel: "Brokers", icon: Building2 },
  { to: "/search", label: "Search", desktopLabel: "Search", icon: Search },
  { to: "/monitored", label: "Monitored", desktopLabel: "Monitored", icon: Radar },
  { to: "/notifications", label: "Alerts", desktopLabel: "Notifications", icon: Bell },
  { to: "/settings", label: "Settings", desktopLabel: "Settings", icon: Settings },
] as const;

function useUnread() {
  return useApp((s) => s.notifications.filter((n) => !s.readIds.includes(n.id)).length);
}

export function AppShell({
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
  useHydrateSession();
  useHydrateBrokers();
  const unread = useUnread();
  const activeBrokerId = useApp((s) => s.activeBrokerId);
  const activeBroker = useApp((s) => s.brokers.find((b) => b.id === s.activeBrokerId));
  const currentUser = useApp((s) => s.user);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mobileNav = nav.filter((n) => n.to !== "/brokers");

  return (
    <div className="min-h-screen bg-background lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
            <Activity className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">MT5 Monitor</p>
            <p className="truncate text-[11px] text-muted-foreground">Client Live Monitor</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {nav.map((item) => {
            const active = pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.desktopLabel}</span>
                {item.to === "/notifications" && unread > 0 && (
                  <span className="num rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-sidebar-border p-3">
          {currentUser?.role === "ADMIN" && (
            <Link
              to="/admin"
              className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
            >
              <Shield className="size-4 shrink-0" />
              <span className="truncate">Open Admin CRM</span>
            </Link>
          )}
          <div className="rounded-lg border border-border bg-secondary/50 p-3">
            <p className="label-xs">Dashboard focus</p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {activeBroker
                ? activeBroker.name
                : activeBrokerId
                  ? brokerName(activeBrokerId)
                  : "All Brokers"}
            </p>
          </div>
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3" /> Secure session · read-only
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
          <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
              {subtitle && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {right}
              <ThemeToggle />
              <Link
                to="/notifications"
                aria-label={`Notifications, ${unread} unread`}
                className="relative grid size-10 place-items-center rounded-full border border-border bg-secondary text-muted-foreground transition-colors hover:text-foreground lg:hidden"
              >
                <Bell className="size-4" />
                {unread > 0 && (
                  <span className="num absolute -top-1 -right-1 min-w-4.5 rounded-full bg-primary px-1 text-[10px] leading-4.5 font-bold text-primary-foreground">
                    {unread}
                  </span>
                )}
              </Link>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-4 pb-28 sm:px-6 lg:pb-10">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
          <div className="grid grid-cols-5">
            {mobileNav.map((item) => {
              const active = pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "relative flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <span className="relative">
                    <item.icon className="size-5" />
                    {item.to === "/notifications" && unread > 0 && (
                      <span className="num absolute -top-1.5 -right-2 min-w-4 rounded-full bg-primary px-1 text-[9px] leading-4 font-bold text-primary-foreground">
                        {unread}
                      </span>
                    )}
                  </span>
                  {item.label}
                  {active && (
                    <span
                      className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
                      aria-hidden
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
