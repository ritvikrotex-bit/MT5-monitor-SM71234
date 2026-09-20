import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "./crypto";
import { ApiError } from "./errors";
import { isPostgresConfigured, query } from "./db";
import { dataFile } from "./paths";

export type BrokerStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "ERROR";

export type StoredBroker = {
  id: string;
  ownerUserId: string;
  name: string;
  server: string;
  managerLogin: string;
  encryptedPassword: string;
  status: BrokerStatus;
  statusMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicBroker = Omit<StoredBroker, "encryptedPassword">;

type FileShape = { brokers: StoredBroker[] };

function filePath(): string {
  return dataFile("brokers.json");
}

let memoryBrokers: StoredBroker[] | null = null;

function readAll(): StoredBroker[] {
  if (memoryBrokers) return memoryBrokers;

  const path = filePath();
  if (!existsSync(path)) {
    memoryBrokers = [];
    return memoryBrokers;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileShape;
    memoryBrokers = parsed.brokers ?? [];
    return memoryBrokers;
  } catch {
    memoryBrokers = [];
    return memoryBrokers;
  }
}

function syncBrokerToPostgres(b: StoredBroker): void {
  if (!isPostgresConfigured()) return;
  void query(
    `INSERT INTO brokers (
      id, owner_user_id, name, server, manager_login, encrypted_password,
      status, status_message, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      server = EXCLUDED.server,
      manager_login = EXCLUDED.manager_login,
      encrypted_password = EXCLUDED.encrypted_password,
      status = EXCLUDED.status,
      status_message = EXCLUDED.status_message,
      updated_at = EXCLUDED.updated_at;`,
    [
      b.id,
      b.ownerUserId,
      b.name,
      b.server,
      String(b.managerLogin),
      b.encryptedPassword,
      b.status || "DISCONNECTED",
      b.statusMessage || "",
      b.createdAt ? new Date(b.createdAt) : new Date(),
      b.updatedAt ? new Date(b.updatedAt) : new Date(),
    ],
  ).catch((err) => console.error("[PostgreSQL] Broker sync error:", err));
}

function deleteBrokerFromPostgres(id: string): void {
  if (!isPostgresConfigured()) return;
  void query(`DELETE FROM brokers WHERE id = $1;`, [id]).catch((err) =>
    console.error("[PostgreSQL] Broker delete error:", err),
  );
}

function writeAll(brokers: StoredBroker[]): void {
  memoryBrokers = brokers;
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ brokers }, null, 2), "utf8");

  if (isPostgresConfigured()) {
    for (const b of brokers) {
      syncBrokerToPostgres(b);
    }
  }
}

// Hydrate brokers from PostgreSQL on boot if available
if (isPostgresConfigured()) {
  void (async () => {
    try {
      // PostgreSQL rows are untyped snake_case records; mapped explicitly below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await query<any>("SELECT * FROM brokers ORDER BY created_at ASC");
      if (rows && rows.length > 0) {
        memoryBrokers = rows.map((r) => ({
          id: r.id,
          ownerUserId: r.owner_user_id,
          name: r.name,
          server: r.server,
          managerLogin: r.manager_login,
          encryptedPassword: r.encrypted_password,
          status: r.status,
          statusMessage: r.status_message,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
        }));
      }
    } catch (err) {
      console.error("[PostgreSQL] Hydration error for brokers:", err);
    }
  })();
}

function publicBroker(row: StoredBroker): PublicBroker {
  const { encryptedPassword: _hidden, ...rest } = row;
  return rest;
}

export function listBrokers(userId: string): PublicBroker[] {
  return readAll()
    .filter((b) => b.ownerUserId === userId)
    .map(publicBroker);
}

export function listAllBrokers(): PublicBroker[] {
  return readAll().map(publicBroker);
}

export function getBroker(userId: string, id: string): StoredBroker {
  const row = readAll().find((b) => b.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_BROKER", "You do not have access to this broker.", 403);
  }
  return row;
}

export function getPublicBroker(userId: string, id: string): PublicBroker {
  return publicBroker(getBroker(userId, id));
}

export async function createBroker(
  userId: string,
  input: { name: string; server: string; managerLogin: string; password: string },
): Promise<PublicBroker> {
  const now = new Date().toISOString();
  const row: StoredBroker = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    name: input.name.trim(),
    server: input.server.trim(),
    managerLogin: input.managerLogin.trim(),
    encryptedPassword: await encryptSecret(input.password),
    status: "DISCONNECTED",
    statusMessage: "Saved. Test the connection to open a Manager session.",
    createdAt: now,
    updatedAt: now,
  };
  const all = readAll();
  all.push(row);
  writeAll(all);
  return publicBroker(row);
}

export async function updateBroker(
  userId: string,
  id: string,
  patch: { name?: string; server?: string; managerLogin?: string; password?: string },
): Promise<PublicBroker> {
  const all = readAll();
  const idx = all.findIndex((b) => b.id === id);
  const current = idx >= 0 ? all[idx] : undefined;
  if (!current || current.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_BROKER", "You do not have access to this broker.", 403);
  }
  const next: StoredBroker = {
    ...current,
    name: patch.name?.trim() ?? current.name,
    server: patch.server?.trim() ?? current.server,
    managerLogin: patch.managerLogin?.trim() ?? current.managerLogin,
    updatedAt: new Date().toISOString(),
  };
  if (patch.password) {
    next.encryptedPassword = await encryptSecret(patch.password);
    next.status = "DISCONNECTED";
    next.statusMessage = "Credentials updated. Test the connection again.";
  }
  all[idx] = next;
  writeAll(all);
  return publicBroker(next);
}

export function deleteBroker(userId: string, id: string): void {
  const all = readAll();
  const row = all.find((b) => b.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_BROKER", "You do not have access to this broker.", 403);
  }
  writeAll(all.filter((b) => b.id !== id));
  deleteBrokerFromPostgres(id);
}

export function setBrokerStatus(
  userId: string,
  id: string,
  status: BrokerStatus,
  statusMessage: string,
): PublicBroker {
  const all = readAll();
  const idx = all.findIndex((b) => b.id === id);
  const current = idx >= 0 ? all[idx] : undefined;
  if (!current || current.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_BROKER", "You do not have access to this broker.", 403);
  }
  const next: StoredBroker = {
    ...current,
    status,
    statusMessage,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = next;
  writeAll(all);
  return publicBroker(next);
}

export async function decryptBrokerPassword(row: StoredBroker): Promise<string> {
  return decryptSecret(row.encryptedPassword);
}
