import { useSyncExternalStore } from "react";
import { type Broker, type NotificationType, type TradeNotification } from "./mt5-data";

export type EventPrefs = Record<NotificationType, boolean>;

export type UserProfile = {
  id: string;
  name: string;
  email: string;
  username: string;
  role: "ADMIN" | "USER";
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "DELETED";
  permissions?: Record<string, boolean>;
  limits?: { maxBrokers: number; maxMonitoredClients: number };
};

export type AppState = {
  authed: boolean;
  userName: string;
  user: UserProfile | null;
  role: "ADMIN" | "USER" | null;
  brokers: Broker[];
  activeBrokerId: string | null;
  monitored: string[]; // client logins
  notifications: TradeNotification[];
  readIds: string[];
  pushEnabled: boolean;
  pushPromptSeen: boolean;
  telegram: { connected: boolean; handle: string | null };
  emailAlerts: boolean;
  events: EventPrefs;
  connectionOk: boolean;
};

const defaultEvents: EventPrefs = {
  new_position: true,
  position_closed: true,
  position_modified: true,
  sl_modified: true,
  tp_modified: false,
};

const getInitialActiveBroker = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const val = localStorage.getItem("mt5_active_broker_id");
    if (!val || val === "none") return null;
    return val;
  } catch {
    return null;
  }
};

let state: AppState = {
  authed: false,
  userName: "Operator",
  user: null,
  role: null,
  brokers: [],
  activeBrokerId: getInitialActiveBroker(),
  monitored: [],
  notifications: [],
  readIds: [],
  pushEnabled: false,
  pushPromptSeen: false,
  telegram: { connected: false, handle: null },
  emailAlerts: false,
  events: defaultEvents,
  connectionOk: true,
};

const listeners = new Set<() => void>();

const set = (patch: Partial<AppState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const store = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
  setUser: (user: UserProfile | null) =>
    set({
      user,
      authed: Boolean(user),
      userName: user?.name || state.userName,
      role: user?.role || null,
    }),
  signIn: (userName?: string, user?: UserProfile | null) =>
    set({
      authed: true,
      ...(userName ? { userName } : {}),
      ...(user ? { user, role: user.role } : {}),
    }),
  signOut: () => set({ authed: false, user: null, role: null }),
  selectBroker: (id: string | null) => {
    if (typeof window !== "undefined") {
      try {
        if (id) localStorage.setItem("mt5_active_broker_id", id);
        else localStorage.setItem("mt5_active_broker_id", "none");
      } catch {
        // localStorage unavailable (private mode / blocked): selection just won't persist.
      }
    }
    set({ activeBrokerId: id });
  },
  setBrokers: (brokers: Broker[]) => {
    let active = state.activeBrokerId;
    if (brokers.length > 0) {
      if (active && !brokers.some((b) => b.id === active)) {
        active = null;
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem("mt5_active_broker_id", "none");
          } catch {
            // localStorage unavailable: nothing to reset.
          }
        }
      }
    }
    set({ brokers, activeBrokerId: active });
  },
  addBroker: (b: Omit<Broker, "id" | "status" | "lastUpdate">) =>
    set({
      brokers: [
        ...state.brokers,
        {
          ...b,
          id: b.name.toLowerCase().replace(/\s+/g, "-") + "-" + Date.now().toString(36),
          status: "connected",
          lastUpdate: "now",
        },
      ],
    }),
  toggleMonitor: (login: string) =>
    set({
      monitored: state.monitored.includes(login)
        ? state.monitored.filter((l) => l !== login)
        : [...state.monitored, login],
    }),
  setNotifications: (notifications: TradeNotification[]) => set({ notifications }),
  setMonitored: (monitored: string[]) => set({ monitored }),
  markAllRead: () => set({ readIds: state.notifications.map((n) => n.id) }),
  markRead: (id: string) =>
    set({ readIds: state.readIds.includes(id) ? state.readIds : [...state.readIds, id] }),
  setPush: (v: boolean) => set({ pushEnabled: v, pushPromptSeen: true }),
  dismissPushPrompt: () => set({ pushPromptSeen: true }),
  setTelegram: (connected: boolean) =>
    set({ telegram: { connected, handle: connected ? "@alert_channel" : null } }),
  setEmailAlerts: (v: boolean) => set({ emailAlerts: v }),
  setEvent: (k: NotificationType, v: boolean) => set({ events: { ...state.events, [k]: v } }),
  setConnectionOk: (v: boolean) => set({ connectionOk: v }),
};

// Display name for a broker id, from the live broker list (falls back to the id until loaded).
export const brokerName = (id: string): string =>
  state.brokers.find((b) => b.id === id)?.name ?? id;

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(state),
    () => select(state),
  );
}

export const useAppState = () => useSyncExternalStore(store.subscribe, store.get, store.get);
