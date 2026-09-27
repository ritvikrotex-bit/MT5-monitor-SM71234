import { copierSecret, copierUrl } from "./env";
import { ApiError } from "./errors";
import { buildCopierServiceConfig } from "./copier-store";

/**
 * Client for the local trade-copier service (mt5-copier).
 *
 * The web app is the source of truth for configuration: it decrypts the stored
 * trading passwords and pushes the whole desired state after every change. The
 * service keeps only runtime state (which destination position mirrors which
 * master one).
 */

export type CopierAccountSnapshot = {
  account: {
    login: number;
    name: string;
    server: string;
    company: string;
    currency: string;
    balance: number;
    equity: number;
    marginFree: number;
    leverage: number;
    hedging: boolean;
    /** 0 demo, 1 contest, 2 real money. */
    tradeMode: number;
    tradeAllowed: boolean;
  };
  positions: {
    ticket: number;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    priceOpen: number;
    sl: number;
    tp: number;
    profit: number;
    magic: number;
    comment: string;
  }[];
};

export type CopierLinkStatus = {
  id: string;
  label: string;
  masterId: string;
  destId: string;
  enabled: boolean;
  dryRun: boolean;
  magic: number;
  state: {
    seeded: boolean;
    copiedPositions: number;
    ignored: number;
    haltedReason: string | null;
    copiedCount: number;
    lastActionAt: number | null;
  };
  cycle: {
    at?: number;
    error?: string | null;
    masterPositions?: number;
    copiedPositions?: number;
    masterEquity?: number;
    destEquity?: number;
  };
};

export type CopierStatus = {
  running: boolean;
  pollInterval: number;
  accounts: Record<
    string,
    { label: string; login: number; running: boolean; lastError: string | null }
  >;
  links: CopierLinkStatus[];
};

export type CopierEvent = {
  /** Monotonic cursor, so a follower can ask only for what it has not seen. */
  seq?: number;
  at: number;
  linkId: string;
  linkLabel: string;
  ownerId: string | null;
  masterLabel?: string;
  destLabel?: string;
  kind: string;
  message: string;
  dryRun: boolean;
  symbol?: string;
  side?: string;
  volume?: number;
  price?: number;
  profit?: number;
  ticket?: number;
  masterTicket?: number;
  masterSymbol?: string;
  masterSide?: string;
  masterVolume?: number;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${copierUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Copier-Secret": copierSecret(),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      "COPIER_UNAVAILABLE",
      "The trade copier service is unreachable. Start the MT5MonitorCopier Windows service.",
      503,
    );
  }
  const payload = (await res.json().catch(() => null)) as
    (T & { detail?: string; error?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(
      payload?.error ?? "COPIER_ERROR",
      payload?.detail ?? payload?.message ?? "The trade copier rejected the request.",
      res.status === 401 ? 502 : res.status === 404 ? 404 : res.status === 503 ? 503 : 502,
    );
  }
  return payload as T;
}

/** Send the full configuration. Safe to call on every change; it replaces state. */
export async function pushCopierConfig(): Promise<{
  accounts: number;
  links: number;
  problems: string[];
}> {
  const config = await buildCopierServiceConfig();
  return call("/v1/config", { method: "PUT", body: JSON.stringify(config) });
}

/**
 * Push configuration without failing the caller if the service is down.
 *
 * Used after a save: the change is already persisted, so a copier that is
 * temporarily stopped must not turn a successful edit into an error. It picks
 * the change up from the next push or on the web app's next boot.
 */
export async function pushCopierConfigQuietly(): Promise<string | null> {
  try {
    await pushCopierConfig();
    return null;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err);
    console.error("[copier] could not push configuration:", message);
    return message;
  }
}

export async function copierStatus(): Promise<CopierStatus> {
  return call<CopierStatus>("/v1/status", { method: "GET" });
}

export async function copierEvents(
  limit = 100,
  since?: number,
): Promise<{ events: CopierEvent[]; cursor?: number }> {
  const params = new URLSearchParams({ limit: String(limit) });
  // 0 is a real cursor, so only an absent value means "just give me the feed".
  if (typeof since === "number" && since >= 0) params.set("since", String(since));
  return call<{ events: CopierEvent[]; cursor?: number }>(`/v1/events?${params}`, {
    method: "GET",
  });
}

export async function probeCopierAccount(accountId: string): Promise<CopierAccountSnapshot> {
  return call<CopierAccountSnapshot>(`/v1/accounts/${accountId}/probe`, { method: "POST" });
}

export async function copierAccountSymbols(
  accountId: string,
  query = "",
): Promise<{ symbols: string[]; total: number }> {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
  return call(`/v1/accounts/${accountId}/symbols${suffix}`, { method: "GET" });
}

export async function armCopierLink(linkId: string): Promise<{ ok: boolean }> {
  return call(`/v1/links/${linkId}/arm`, { method: "POST" });
}

export async function flattenCopierLink(
  linkId: string,
): Promise<{ ok: boolean; closed: number; remaining: number }> {
  return call(`/v1/links/${linkId}/flatten`, { method: "POST" });
}

export type PreviewRow = {
  source: string;
  destination: string | null;
  status: "AUTO" | "MANUAL" | "BLOCKED" | "AMBIGUOUS" | "UNMATCHED";
  detail: string;
};

export type TranslationPreview = {
  counts: Partial<Record<PreviewRow["status"], number>>;
  matching: number;
  sourceTotal: number;
  destinationTotal: number;
  rows: PreviewRow[];
};

/** How a link would translate every symbol its master could trade. */
export async function copierLinkPreview(
  linkId: string,
  query = "",
  limit = 400,
): Promise<TranslationPreview> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("q", query);
  return call(`/v1/links/${linkId}/preview?${params}`, { method: "GET" });
}
