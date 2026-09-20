import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "./crypto";
import { ApiError } from "./errors";
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

function readAll(): StoredBroker[] {
  const path = filePath();
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as FileShape;
  return parsed.brokers ?? [];
}

function writeAll(brokers: StoredBroker[]): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ brokers }, null, 2), "utf8");
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
