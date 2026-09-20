import { connectorSecret, connectorUrl } from "./env";
import { ApiError } from "./errors";

export type ConnectorStatus =
  "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "ERROR";

export type ConnectorClientAccount = {
  login: number;
  name: string;
  group?: string | null;
  balance?: number | null;
  equity?: number | null;
  margin?: number | null;
  floatingProfit?: number | null;
  leverage?: number | null;
  currency?: string | null;
};

export type ConnectorPosition = {
  positionId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice?: number | null;
  profit: number;
  sl?: number | null;
  tp?: number | null;
  openedAt?: string | null;
};

type Creds = { server: string; login: number; password: string };

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 4000;

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = fn().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

function cached<T>(key: string, fn: () => Promise<T>, ttl = CACHE_MS): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value as T);
  return dedupe(key, async () => {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const url = `${connectorUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Connector-Secret": connectorSecret(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "CONNECTOR_UNAVAILABLE",
      "The MT5 connector is unreachable. Start the Windows connector service.",
      503,
    );
  }

  const payload = (await res.json().catch(() => null)) as
    (T & { error?: string; message?: string }) | null;

  if (!res.ok) {
    throw new ApiError(
      payload?.error ?? "CONNECTOR_ERROR",
      payload?.message ?? "The broker connection is currently unavailable.",
      res.status === 401 ? 401 : res.status === 404 ? 404 : res.status === 503 ? 503 : 502,
    );
  }
  return payload as T;
}

export async function connectorTest(creds: Creds) {
  return call<{ ok: boolean; message: string; status: ConnectorStatus; mode: string }>(
    "/v1/test",
    creds,
  );
}

export async function connectorConnect(creds: Creds) {
  return call<{ status: ConnectorStatus; message: string }>("/v1/session/connect", creds);
}

export async function connectorDisconnect(creds: Creds) {
  return call<{ status: ConnectorStatus; message: string }>("/v1/session/disconnect", creds);
}

export async function connectorStatus(creds: Creds) {
  return call<{ status: ConnectorStatus; message: string }>("/v1/session/status", creds);
}

export async function connectorSearch(creds: Creds, query: string, by: string) {
  const key = `search:${creds.server}:${creds.login}:${by}:${query}`;
  return cached(key, () =>
    call<{ clients: ConnectorClientAccount[]; mode: string }>("/v1/clients/search", {
      ...creds,
      query,
      by,
    }),
  );
}

export async function connectorGetAccount(creds: Creds, account: number) {
  const key = `acct:${creds.server}:${creds.login}:${account}`;
  return cached(key, () =>
    call<{ client: ConnectorClientAccount; mode: string }>("/v1/clients/get", {
      ...creds,
      account,
    }),
  );
}

export async function connectorGetPositions(creds: Creds, account: number) {
  const key = `pos:${creds.server}:${creds.login}:${account}`;
  return dedupe(key, () =>
    call<{
      clientLogin: number;
      positions: ConnectorPosition[];
      slTpAvailable: boolean;
      mode: string;
    }>("/v1/clients/positions", { ...creds, account }),
  );
}
