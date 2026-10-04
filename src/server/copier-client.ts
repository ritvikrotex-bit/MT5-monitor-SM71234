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
    /** The slave broker's server date the daily counters belong to. */
    day?: string | null;
    tradesToday?: number;
    /** Set while a losing-streak pause is on; cleared by arming. */
    riskBlock?: string | null;
    /** Only when a daily-loss or losing-streak limit is configured. */
    today?: { realized: number; floating: number; total: number; lossStreak: number } | null;
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

/** How one account's terminal worker is doing. */
export type CopierWorkerStatus = {
  label: string;
  login: number;
  running: boolean;
  /** The terminal answered; false while it is still starting. Absent from older copiers. */
  ready?: boolean;
  lastError: string | null;
  /** Seconds since the epoch of the last command the worker answered. */
  lastOkAt?: number | null;
  startedAt?: number | null;
  /** More than one means it has been restarted. */
  starts?: number;
};

export type CopierStatus = {
  running: boolean;
  pollInterval: number;
  accounts: Record<string, CopierWorkerStatus>;
  links: CopierLinkStatus[];
};

/** What logging the destination in again found. */
export type CopierRefresh = {
  ok: boolean;
  error?: string;
  symbol?: string | null;
  available?: boolean | null;
  reason?: string | null;
  symbolsBefore?: number;
  symbolsAfter?: number;
};

export type CopierTestStep = {
  key: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  /** For symbol steps: why this symbol was chosen. */
  sample?: string;
};

export type CopierTestResult = {
  ok: boolean;
  at: number;
  linkId: string;
  linkLabel: string;
  masterLabel: string;
  steps: CopierTestStep[];
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
  /** Why a trade was not copied. */
  reason?: string;
  /** Set when the destination was logged in again while handling this trade. */
  refresh?: CopierRefresh;
  /** outage / recovered: which account could not be read, and since when (epoch s). */
  account?: "master" | "slave";
  since?: number;
  openCopies?: number;
  downSeconds?: number;
  /** risk: which limit, what was hit, and when copying resumes. */
  trigger?: string;
  limit?: string | number;
  detail?: string;
  resumes?: string;
  realized?: number;
  floating?: number;
  /** trailing_exit */
  peak?: number;
  floor?: number;
  retracement?: number;
  exitProfit?: number;
  drawdownPct?: number;
  activation?: number;
  /** loss_stop */
  loss?: number;
  /** reduce: the copy's and the master's volume before the trim. */
  fromVolume?: number;
  masterFromVolume?: number;
  /** opened: copy latency (slave fill − master execution) and its parts, in ms. */
  latencyMs?: number;
  detectionMs?: number;
  executionMs?: number;
  /** opened: set instead of latency when this machine's clock is behind the broker's. */
  clockSkewMs?: number;
  /** opened: fill vs the master's entry, in slave points; positive is worse. */
  slippagePoints?: number;
  masterPrice?: number;
};

/** One copy from the trade journal: its open, and its close once closed. */
export type CopierJournalTrade = {
  status: "open" | "closed";
  linkId: string;
  linkLabel?: string;
  masterLabel?: string;
  masterTicket: number;
  masterSymbol?: string;
  masterVolume?: number;
  masterPrice?: number;
  masterExecutedAt?: number;
  ticket?: number;
  symbol?: string;
  side?: string;
  volume?: number;
  price?: number;
  seenAt?: number;
  sentAt?: number;
  filledAt?: number;
  openedAt?: number;
  latencyMs?: number;
  detectionMs?: number;
  executionMs?: number;
  slippagePoints?: number;
  closedAt?: number;
  closePrice?: number;
  closeReason?: string;
  profit?: number;
  swap?: number;
  dryRun?: boolean;
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
  } catch (err) {
    // Node's fetch gives up on a silent server after ~5 minutes; the copier is
    // up but busy, typically starting an account's MT5 terminal.
    const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (cause === "UND_ERR_HEADERS_TIMEOUT" || cause === "UND_ERR_BODY_TIMEOUT") {
      throw new ApiError(
        "COPIER_TIMEOUT",
        "The trade copier is running but did not answer in time. It is probably still starting " +
          "this account's MT5 terminal; check the account's status in a minute.",
        504,
      );
    }
    throw new ApiError(
      "COPIER_UNAVAILABLE",
      "The trade copier service is unreachable. Start the MT5MonitorCopier Windows service.",
      503,
    );
  }
  const payload = (await res.json().catch(() => null)) as
    (T & { detail?: string; error?: string; message?: string }) | null;
  if (res.status === 404 && payload?.detail === "Not Found") {
    // FastAPI's answer for a route it does not have, as opposed to our own
    // 404s ("unknown link"): the copier predates this feature.
    throw new ApiError(
      "COPIER_OUTDATED",
      "The trade copier service is running an older version that does not have this feature. " +
        "Restart the copier (Ctrl+C in its window, then start it again) to load the latest version.",
      503,
    );
  }
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
): Promise<{ events: CopierEvent[]; cursor?: number; boot?: string }> {
  const params = new URLSearchParams({ limit: String(limit) });
  // 0 is a real cursor, so only an absent value means "just give me the feed".
  if (typeof since === "number" && since >= 0) params.set("since", String(since));
  return call<{ events: CopierEvent[]; cursor?: number; boot?: string }>(`/v1/events?${params}`, {
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

/** Copies made by these links, newest first, with latency, slippage and result. */
export async function copierJournal(
  linkIds: string[],
  limit = 500,
): Promise<{ trades: CopierJournalTrade[] }> {
  if (linkIds.length === 0) return { trades: [] };
  const params = new URLSearchParams({ links: linkIds.join(","), limit: String(limit) });
  return call(`/v1/journal?${params}`, { method: "GET" });
}

/** Check a link end to end. The copier places no order for this. */
export async function testCopierLink(linkId: string): Promise<CopierTestResult> {
  return call<CopierTestResult>(`/v1/links/${linkId}/test`, { method: "POST" });
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
