import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPostgresConfigured, query } from "./db";
import { dataFile } from "./paths";

export type MonitoredClient = {
  userId: string;
  brokerId: string;
  login: number;
  clientName?: string | undefined;
  createdAt: string;
};

type Store = { monitored: MonitoredClient[] };

const path = () => dataFile("monitored.json");

let memoryMonitored: MonitoredClient[] | null = null;

const read = (): MonitoredClient[] => {
  if (memoryMonitored) return memoryMonitored;
  if (!existsSync(path())) {
    memoryMonitored = [];
    return memoryMonitored;
  }
  try {
    memoryMonitored = (JSON.parse(readFileSync(path(), "utf8")) as Store).monitored || [];
    return memoryMonitored;
  } catch {
    memoryMonitored = [];
    return memoryMonitored;
  }
};

const write = (monitored: MonitoredClient[]) => {
  memoryMonitored = monitored;
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify({ monitored }, null, 2), "utf8");
};

function syncMonitoredToPostgres(item: MonitoredClient): void {
  if (!isPostgresConfigured()) return;
  void query(
    `INSERT INTO monitored_clients (user_id, broker_id, login, client_name, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, broker_id, login) DO UPDATE SET client_name = EXCLUDED.client_name;`,
    [item.userId, item.brokerId, item.login, item.clientName || null, new Date(item.createdAt)],
  ).catch((err) => console.error("[PostgreSQL] Monitored sync error:", err));
}

function deleteMonitoredFromPostgres(userId: string, brokerId: string, login: number): void {
  if (!isPostgresConfigured()) return;
  void query(
    `DELETE FROM monitored_clients WHERE user_id = $1 AND broker_id = $2 AND login = $3;`,
    [userId, brokerId, login],
  ).catch((err) => console.error("[PostgreSQL] Monitored delete error:", err));
}

// Hydrate from PostgreSQL on startup if enabled
if (isPostgresConfigured()) {
  void (async () => {
    try {
      // PostgreSQL rows are untyped snake_case records; mapped explicitly below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await query<any>("SELECT * FROM monitored_clients ORDER BY created_at ASC");
      if (rows && rows.length > 0) {
        memoryMonitored = rows.map((r) => ({
          userId: r.user_id,
          brokerId: r.broker_id,
          login: Number(r.login),
          clientName: r.client_name || undefined,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        }));
      }
    } catch (err) {
      console.error("[PostgreSQL] Hydration error for monitored accounts:", err);
    }
  })();
}

export const listMonitored = (userId: string) => read().filter((item) => item.userId === userId);
export const listAllMonitored = () => read();

export const addMonitored = (
  userId: string,
  brokerId: string,
  login: number,
  clientName?: string,
) => {
  const all = read();
  if (
    !all.some(
      (item) => item.userId === userId && item.brokerId === brokerId && item.login === login,
    )
  ) {
    const item: MonitoredClient = {
      userId,
      brokerId,
      login,
      clientName,
      createdAt: new Date().toISOString(),
    };
    all.push(item);
    write(all);
    syncMonitoredToPostgres(item);
  }
};

export const removeMonitored = (userId: string, brokerId: string, login: number) => {
  write(
    read().filter(
      (item) => item.userId !== userId || item.brokerId !== brokerId || item.login !== login,
    ),
  );
  deleteMonitoredFromPostgres(userId, brokerId, login);
};
