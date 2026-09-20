import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile } from "./paths";

export type AlertType =
  "new_position" | "position_closed" | "position_modified" | "sl_modified" | "tp_modified";
export type AlertPosition = {
  positionId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice?: number | null | undefined;
  profit: number;
  sl?: number | null | undefined;
  tp?: number | null | undefined;
  openedAt?: string | null | undefined;
};
export type StoredAlert = {
  id: string;
  userId: string;
  brokerId: string;
  brokerName?: string | undefined;
  type: AlertType;
  clientLogin: string;
  clientName: string;
  position: AlertPosition;
  from?: number | null | undefined;
  to?: number | null | undefined;
  createdAt: string;
  telegram: "sent" | "not_configured" | "failed";
  telegramError?: string | undefined;
};
type Store = { alerts: StoredAlert[]; snapshots: Record<string, AlertPosition[]> };

const path = () => dataFile("notifications.json");
const empty = (): Store => ({ alerts: [], snapshots: {} });
const read = (): Store =>
  existsSync(path())
    ? { ...empty(), ...(JSON.parse(readFileSync(path(), "utf8")) as Partial<Store>) }
    : empty();
const write = (store: Store) => {
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify(store, null, 2), "utf8");
};

declare global {
  var __mt5_snapshots_cache__: Record<string, AlertPosition[]> | undefined;
}

const getSnapshotsCache = (): Record<string, AlertPosition[]> => {
  if (!globalThis.__mt5_snapshots_cache__) {
    globalThis.__mt5_snapshots_cache__ = read().snapshots || {};
  }
  return globalThis.__mt5_snapshots_cache__;
};

export const snapshotKey = (userId: string, brokerId: string, login: number) =>
  `${userId}:${brokerId}:${login}`;
export const readSnapshot = (key: string) => getSnapshotsCache()[key];
export const writeSnapshot = (key: string, positions: AlertPosition[]) => {
  const cache = getSnapshotsCache();
  cache[key] = positions;
  try {
    const store = read();
    store.snapshots = { ...cache };
    write(store);
  } catch (err) {
    console.error("[MT5 Store] Failed to persist snapshot to disk:", err);
  }
};
export const appendAlert = (alert: StoredAlert) => {
  const store = read();
  store.alerts.unshift(alert);
  store.alerts = store.alerts.slice(0, 2_000);
  write(store);
};
export const listAlerts = (userId: string, limit = 100) =>
  read()
    .alerts.filter((alert) => alert.userId === userId)
    .slice(0, limit);
