import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptBrokerPassword, getBroker, listBrokers } from "./broker-store";
import { decryptSecret, encryptSecret } from "./crypto";
import { ApiError } from "./errors";
import { dataFile } from "./paths";

/**
 * Trade-copier configuration.
 *
 * The two sides of a copy link are stored very differently, because they need
 * very different access:
 *
 * - The **master** is only ever watched. It is an account on a broker we
 *   already hold Manager credentials for, so it is identified by broker id
 *   plus MT5 login and read through mt5-connector. We never hold, or need, its
 *   own password, and nothing on this path can place an order on it.
 * - The **destination** is traded on, which needs a terminal logged in with
 *   that account's trading password. Those are the accounts stored here, with
 *   their passwords encrypted using the same AES-256-GCM key as broker manager
 *   passwords.
 */

/**
 * What a stored MT5 account may be used for.
 *
 * MASTER accounts are only ever read, so marking one keeps it out of every
 * destination picker and stops a slip of the mouse from trading on it.
 */
export type CopierAccountRole = "MASTER" | "DESTINATION" | "BOTH";

export type StoredCopierAccount = {
  id: string;
  ownerUserId: string;
  label: string;
  broker: string;
  role: CopierAccountRole;
  /** Server name as MT5 knows it, or "host:port" for a server not in its list. */
  server: string;
  login: number;
  /**
   * A destination needs the account's *trading* password. A terminal-read
   * master only needs its investor password, which cannot place orders.
   */
  encryptedPassword: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicCopierAccount = Omit<StoredCopierAccount, "encryptedPassword">;

export type CopierRules = {
  symbolMap: Record<string, string>;
  symbolSuffix: string;
  /** Match by undecorated base name. Off means only hand mappings are copied. */
  autoMatch: boolean;
  allowSymbols: string[];
  denySymbols: string[];
  /**
   * EQUITY_STEP: lotValue lots per equityStep of slave equity ($1,000 → 0.01).
   * RISK_PERCENT: lotValue is the % of slave equity lost if the master's SL is hit.
   */
  lotMode: "FIXED" | "MULTIPLIER" | "BALANCE" | "EQUITY" | "EQUITY_STEP" | "RISK_PERCENT";
  lotValue: number;
  equityStep: number;
  maxLot: number;
  minVolumeAction: "SKIP" | "MIN";
  reverse: boolean;
  /** Follow the master's stop loss / take profit, each on its own switch. */
  copySl: boolean;
  copyTp: boolean;
  /** Legacy single switch, read for links saved before SL and TP were split. */
  copySlTp?: boolean;
  copyExisting: boolean;
  maxOpenPositions: number;
  maxSlippagePoints: number;
  // Risk limits; 0 or empty is off. Days and hours are the slave broker's
  // server time. When one trips, new copies stop and open ones stay managed.
  maxTradesPerDay: number;
  maxBuyLots: number;
  maxSellLots: number;
  sessionStart: string;
  sessionEnd: string;
  /** 0 = Monday … 6 = Sunday; empty means every day. */
  sessionDays: number[];
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  /** A copy whose loss reaches this is closed on its own, even if the master stays open. */
  maxLossPerTrade: number;
  /** MASTER follows the master's SL/TP; TRAILING lets the slave trail its own profit. */
  exitMode: "MASTER" | "TRAILING";
  trailActivation: number;
  trailDrawdownPct: number;
};

/**
 * Where a link reads its master from.
 *
 * MANAGER is the normal choice: the account is watched through a broker's
 * Manager connection, needs no password of its own, and cannot be traded on.
 * TERMINAL logs a terminal in to the master account itself, which is only
 * needed when we hold its (investor) password but have no manager access to
 * that server.
 */
export type CopierMaster =
  { kind: "MANAGER"; brokerId: string; login: number } | { kind: "TERMINAL"; accountId: string };

export type StoredCopierLink = {
  id: string;
  ownerUserId: string;
  label: string;
  master: CopierMaster;
  destAccountId: string;
  rules: CopierRules;
  enabled: boolean;
  /** Log every decision, send no orders. New links start here on purpose. */
  dryRun: boolean;
  maxDrawdownPct: number;
  createdAt: string;
  updatedAt: string;
};

type FileShape = { accounts: StoredCopierAccount[]; links: StoredCopierLink[] };

export const DEFAULT_RULES: CopierRules = {
  symbolMap: {},
  symbolSuffix: "",
  autoMatch: true,
  allowSymbols: [],
  denySymbols: [],
  lotMode: "BALANCE",
  lotValue: 1,
  equityStep: 1000,
  maxLot: 0,
  minVolumeAction: "SKIP",
  reverse: false,
  copySl: true,
  copyTp: true,
  copyExisting: false,
  maxOpenPositions: 0,
  maxSlippagePoints: 20,
  maxTradesPerDay: 0,
  maxBuyLots: 0,
  maxSellLots: 0,
  sessionStart: "",
  sessionEnd: "",
  sessionDays: [],
  maxDailyLoss: 0,
  maxConsecutiveLosses: 0,
  maxLossPerTrade: 0,
  exitMode: "MASTER",
  trailActivation: 0,
  trailDrawdownPct: 0,
};

const LOT_MODES = [
  "FIXED",
  "MULTIPLIER",
  "BALANCE",
  "EQUITY",
  "EQUITY_STEP",
  "RISK_PERCENT",
] as const;
const MIN_VOLUME_ACTIONS = ["SKIP", "MIN"] as const;
const EXIT_MODES = ["MASTER", "TRAILING"] as const;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** A non-negative number from a form field, or the fallback. */
function nonNegative(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError("INVALID_RULES", `${label} cannot be negative.`, 400);
  }
  return n;
}
const ROLES = ["MASTER", "DESTINATION", "BOTH"] as const;

function normaliseRole(role: unknown): CopierAccountRole {
  return ROLES.includes(role as CopierAccountRole) ? (role as CopierAccountRole) : "DESTINATION";
}

function filePath(): string {
  return dataFile("copier.json");
}

let memory: FileShape | null = null;
/** Modification time of the file `memory` was read from or written to. */
let memoryMtimeMs = -1;

function fileMtimeMs(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
}

/**
 * The saved configuration. The file is the source of truth: the cached copy is
 * used only while the file is unchanged. Holding a copy for the life of the
 * process let a second instance of this module (a dev reload leaves the old
 * one running the copier's re-sync timer) keep pushing stale rules, which
 * silently undid every save within a minute.
 */
function readAll(): FileShape {
  const path = filePath();
  const mtime = fileMtimeMs(path);
  if (memory && mtime === memoryMtimeMs) return memory;
  if (mtime < 0) {
    memory = { accounts: [], links: [] };
    memoryMtimeMs = mtime;
    return memory;
  }
  try {
    // Reading as utf8 leaves a byte-order mark in place, so a file touched by
    // a Windows editor would fail to parse and silently look empty.
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<FileShape>;
    memory = { accounts: parsed.accounts ?? [], links: parsed.links ?? [] };
    memoryMtimeMs = mtime;
  } catch (err) {
    console.error("[copier] could not parse", path, err);
    // Keep what we had rather than pushing an empty configuration.
    memory ??= { accounts: [], links: [] };
  }
  return memory;
}

function writeAll(next: FileShape): void {
  memory = next;
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  memoryMtimeMs = fileMtimeMs(path);
}

function publicAccount(row: StoredCopierAccount): PublicCopierAccount {
  const { encryptedPassword: _hidden, ...rest } = row;
  return rest;
}

// -- destination accounts ---------------------------------------------------

export function listCopierAccounts(userId: string): PublicCopierAccount[] {
  return readAll()
    .accounts.filter((a) => a.ownerUserId === userId)
    .map(publicAccount);
}

export function getCopierAccount(userId: string, id: string): StoredCopierAccount {
  const row = readAll().accounts.find((a) => a.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_ACCOUNT", "You do not have access to this account.", 403);
  }
  return row;
}

export async function createCopierAccount(
  userId: string,
  input: {
    label: string;
    broker: string;
    server: string;
    login: number;
    password: string;
    role?: string;
  },
): Promise<PublicCopierAccount> {
  const all = readAll();
  const server = input.server.trim();
  const login = Number(input.login);
  if (
    all.accounts.some((a) => a.ownerUserId === userId && a.server === server && a.login === login)
  ) {
    throw new ApiError("DUPLICATE_ACCOUNT", "That account is already set up on this server.", 409);
  }
  const now = new Date().toISOString();
  const row: StoredCopierAccount = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    label: input.label.trim(),
    broker: input.broker.trim(),
    role: normaliseRole(input.role),
    server,
    login,
    encryptedPassword: await encryptSecret(input.password),
    createdAt: now,
    updatedAt: now,
  };
  all.accounts.push(row);
  writeAll(all);
  return publicAccount(row);
}

export async function updateCopierAccount(
  userId: string,
  id: string,
  patch: {
    label?: string;
    broker?: string;
    server?: string;
    login?: number;
    password?: string;
    role?: string;
  },
): Promise<PublicCopierAccount> {
  const all = readAll();
  const idx = all.accounts.findIndex((a) => a.id === id);
  const current = idx >= 0 ? all.accounts[idx] : undefined;
  if (!current || current.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_ACCOUNT", "You do not have access to this account.", 403);
  }
  const next: StoredCopierAccount = {
    ...current,
    label: patch.label?.trim() ?? current.label,
    broker: patch.broker?.trim() ?? current.broker,
    role: patch.role !== undefined ? normaliseRole(patch.role) : current.role,
    server: patch.server?.trim() ?? current.server,
    login: patch.login !== undefined ? Number(patch.login) : current.login,
    updatedAt: new Date().toISOString(),
  };
  if (patch.password) next.encryptedPassword = await encryptSecret(patch.password);
  all.accounts[idx] = next;
  writeAll(all);
  return publicAccount(next);
}

export function deleteCopierAccount(userId: string, id: string): void {
  const all = readAll();
  const row = all.accounts.find((a) => a.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_ACCOUNT", "You do not have access to this account.", 403);
  }
  const usedBy = all.links.filter(
    (l) => l.destAccountId === id || (l.master.kind === "TERMINAL" && l.master.accountId === id),
  );
  if (usedBy.length > 0) {
    throw new ApiError(
      "ACCOUNT_IN_USE",
      `This account is still used by ${usedBy.length} copy link${
        usedBy.length === 1 ? "" : "s"
      }. Remove the link first.`,
      409,
    );
  }
  writeAll({ ...all, accounts: all.accounts.filter((a) => a.id !== id) });
}

// -- links ------------------------------------------------------------------

export function listCopierLinks(userId: string): StoredCopierLink[] {
  return readAll().links.filter((l) => l.ownerUserId === userId);
}

/** Users with at least one running link: who to tell when the copier itself stops. */
export function enabledCopierLinkOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const link of readAll().links) {
    if (!link.enabled) continue;
    owners.set(link.ownerUserId, [...(owners.get(link.ownerUserId) ?? []), link.label]);
  }
  return owners;
}

export function getCopierLink(userId: string, id: string): StoredCopierLink {
  const row = readAll().links.find((l) => l.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_LINK", "You do not have access to this copy link.", 403);
  }
  return row;
}

export function normaliseRules(input: Partial<CopierRules> | undefined): CopierRules {
  const raw = input ?? {};
  const lotMode = LOT_MODES.includes(raw.lotMode as never) ? raw.lotMode! : DEFAULT_RULES.lotMode;
  const lotValue = Number(raw.lotValue ?? DEFAULT_RULES.lotValue);
  if (!Number.isFinite(lotValue) || lotValue <= 0) {
    throw new ApiError("INVALID_RULES", "The lot size must be greater than zero.", 400);
  }
  const maxLot = Number(raw.maxLot ?? 0);
  if (!Number.isFinite(maxLot) || maxLot < 0) {
    throw new ApiError("INVALID_RULES", "The maximum lot cannot be negative.", 400);
  }
  if (lotMode === "RISK_PERCENT" && lotValue > 100) {
    throw new ApiError("INVALID_RULES", "The risk per trade cannot exceed 100% of equity.", 400);
  }
  const equityStep = nonNegative(raw.equityStep, DEFAULT_RULES.equityStep, "The equity step");
  if (equityStep <= 0) {
    throw new ApiError("INVALID_RULES", "The equity step must be greater than zero.", 400);
  }

  const sessionStart = String(raw.sessionStart ?? "").trim();
  const sessionEnd = String(raw.sessionEnd ?? "").trim();
  if ((sessionStart === "") !== (sessionEnd === "")) {
    throw new ApiError("INVALID_RULES", "A trading session needs both a start and an end.", 400);
  }
  for (const value of [sessionStart, sessionEnd]) {
    if (value && !HHMM.test(value)) {
      throw new ApiError("INVALID_RULES", `Session times look like 09:00, not "${value}".`, 400);
    }
  }

  const exitMode = EXIT_MODES.includes(raw.exitMode as never) ? raw.exitMode! : "MASTER";
  const trailDrawdownPct = nonNegative(raw.trailDrawdownPct, 0, "The trailing drawdown");
  if (trailDrawdownPct >= 100) {
    throw new ApiError("INVALID_RULES", "The trailing drawdown must be under 100%.", 400);
  }
  if (exitMode === "TRAILING" && trailDrawdownPct <= 0) {
    throw new ApiError(
      "INVALID_RULES",
      "Trailing needs a drawdown percentage, e.g. 20% to exit at 80% of the peak profit.",
      400,
    );
  }

  // Links saved before SL and TP had separate switches carry one copySlTp.
  const legacyStops = raw.copySlTp ?? true;
  return {
    symbolMap: Object.fromEntries(
      Object.entries(raw.symbolMap ?? {})
        .map(([from, to]) => [String(from).trim(), String(to).trim()])
        .filter(([from, to]) => from && to),
    ),
    symbolSuffix: (raw.symbolSuffix ?? "").trim(),
    autoMatch: raw.autoMatch ?? true,
    allowSymbols: (raw.allowSymbols ?? []).map((s) => String(s).trim()).filter(Boolean),
    denySymbols: (raw.denySymbols ?? []).map((s) => String(s).trim()).filter(Boolean),
    lotMode,
    lotValue,
    equityStep,
    maxLot,
    minVolumeAction: MIN_VOLUME_ACTIONS.includes(raw.minVolumeAction as never)
      ? raw.minVolumeAction!
      : DEFAULT_RULES.minVolumeAction,
    reverse: Boolean(raw.reverse),
    copySl: raw.copySl ?? legacyStops,
    copyTp: raw.copyTp ?? legacyStops,
    copyExisting: Boolean(raw.copyExisting),
    maxOpenPositions: Math.max(0, Number(raw.maxOpenPositions ?? 0) || 0),
    maxSlippagePoints: Math.max(0, Number(raw.maxSlippagePoints ?? 20) || 0),
    maxTradesPerDay: Math.floor(nonNegative(raw.maxTradesPerDay, 0, "Max trades per day")),
    maxBuyLots: nonNegative(raw.maxBuyLots, 0, "Max BUY lots"),
    maxSellLots: nonNegative(raw.maxSellLots, 0, "Max SELL lots"),
    sessionStart,
    sessionEnd,
    sessionDays: [...new Set((raw.sessionDays ?? []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort(),
    maxDailyLoss: nonNegative(raw.maxDailyLoss, 0, "Max daily loss"),
    maxConsecutiveLosses: Math.floor(
      nonNegative(raw.maxConsecutiveLosses, 0, "Max consecutive losses"),
    ),
    maxLossPerTrade: nonNegative(raw.maxLossPerTrade, 0, "Max loss per trade"),
    exitMode,
    trailActivation: nonNegative(raw.trailActivation, 0, "The trailing activation profit"),
    trailDrawdownPct,
  };
}

export function createCopierLink(
  userId: string,
  input: {
    label: string;
    master: CopierMaster;
    destAccountId: string;
    rules?: Partial<CopierRules>;
    maxDrawdownPct?: number;
  },
): StoredCopierLink {
  const master = validateMaster(userId, input.master);
  const destination = getCopierAccount(userId, input.destAccountId);
  if (destination.role === "MASTER") {
    throw new ApiError(
      "INVALID_LINK",
      `${destination.label} is marked master-only, so trades cannot be placed on it.`,
      400,
    );
  }
  if (master.kind === "TERMINAL" && master.accountId === input.destAccountId) {
    throw new ApiError("INVALID_LINK", "An account cannot copy onto itself.", 400);
  }

  const all = readAll();
  if (
    all.links.some((l) => sameMaster(l.master, master) && l.destAccountId === input.destAccountId)
  ) {
    throw new ApiError("DUPLICATE_LINK", "That master is already copied onto that account.", 409);
  }
  const now = new Date().toISOString();
  const row: StoredCopierLink = {
    id: crypto.randomUUID(),
    ownerUserId: userId,
    label: input.label.trim(),
    master,
    destAccountId: input.destAccountId,
    rules: normaliseRules(input.rules),
    // Never auto-arm: a new link starts stopped and in dry run so its rules can
    // be checked against real trades before any money moves.
    enabled: false,
    dryRun: true,
    maxDrawdownPct: Math.max(0, Number(input.maxDrawdownPct ?? 0) || 0),
    createdAt: now,
    updatedAt: now,
  };
  all.links.push(row);
  writeAll(all);
  return row;
}

export function updateCopierLink(
  userId: string,
  id: string,
  patch: {
    label?: string;
    rules?: Partial<CopierRules>;
    enabled?: boolean;
    dryRun?: boolean;
    maxDrawdownPct?: number;
  },
): StoredCopierLink {
  const all = readAll();
  const idx = all.links.findIndex((l) => l.id === id);
  const current = idx >= 0 ? all.links[idx] : undefined;
  if (!current || current.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_LINK", "You do not have access to this copy link.", 403);
  }
  const next: StoredCopierLink = {
    ...current,
    label: patch.label?.trim() ?? current.label,
    rules: patch.rules ? normaliseRules({ ...current.rules, ...patch.rules }) : current.rules,
    enabled: patch.enabled ?? current.enabled,
    dryRun: patch.dryRun ?? current.dryRun,
    maxDrawdownPct:
      patch.maxDrawdownPct !== undefined
        ? Math.max(0, Number(patch.maxDrawdownPct) || 0)
        : current.maxDrawdownPct,
    updatedAt: new Date().toISOString(),
  };
  all.links[idx] = next;
  writeAll(all);
  return next;
}

export function deleteCopierLink(userId: string, id: string): void {
  const all = readAll();
  const row = all.links.find((l) => l.id === id);
  if (!row || row.ownerUserId !== userId) {
    throw new ApiError("UNAUTHORIZED_LINK", "You do not have access to this copy link.", 403);
  }
  writeAll({ ...all, links: all.links.filter((l) => l.id !== id) });
}

function sameMaster(a: CopierMaster, b: CopierMaster): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "MANAGER" && b.kind === "MANAGER"
    ? a.brokerId === b.brokerId && a.login === b.login
    : (a as { accountId: string }).accountId === (b as { accountId: string }).accountId;
}

/** Check a master belongs to this user and is usable, and return it normalised. */
function validateMaster(userId: string, master: CopierMaster | undefined): CopierMaster {
  if (!master || (master.kind !== "MANAGER" && master.kind !== "TERMINAL")) {
    throw new ApiError("INVALID_LINK", "Choose where the master is read from.", 400);
  }
  if (master.kind === "MANAGER") {
    const login = Number(master.login);
    if (!Number.isInteger(login) || login <= 0) {
      throw new ApiError("INVALID_LINK", "The master's MT5 login must be a number.", 400);
    }
    getBroker(userId, master.brokerId); // throws when it is not theirs
    return { kind: "MANAGER", brokerId: master.brokerId, login };
  }
  const account = getCopierAccount(userId, master.accountId);
  if (account.role === "DESTINATION") {
    throw new ApiError(
      "INVALID_LINK",
      `${account.label} is marked destination-only, so it cannot be a master.`,
      400,
    );
  }
  return { kind: "TERMINAL", accountId: master.accountId };
}

/** Brokers this user could pick a master account from. */
export function listMasterBrokers(userId: string) {
  return listBrokers(userId).map((b) => ({
    id: b.id,
    name: b.name,
    server: b.server,
    status: b.status,
  }));
}

// -- pushing to the copier service -----------------------------------------

export type CopierServiceConfig = {
  accounts: { id: string; label: string; server: string; login: number; password: string }[];
  links: Record<string, unknown>[];
};

/**
 * Build the payload for the copier service.
 *
 * This is the only place destination passwords and broker manager passwords
 * are decrypted, and the result goes straight to the local copier over
 * loopback. It covers every user, because one service runs all links; per-user
 * access control happens in the routes.
 *
 * A link whose broker has gone missing is dropped rather than shipped
 * half-formed, so the copier never runs a link whose master it cannot read.
 */
export async function buildCopierServiceConfig(): Promise<CopierServiceConfig> {
  const { accounts, links } = readAll();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const usable: StoredCopierLink[] = [];
  const masters: Record<string, unknown>[] = [];

  for (const link of links) {
    if (!byId.has(link.destAccountId)) {
      console.error(
        `[copier] link ${link.id} (${link.label}) has no destination account ${link.destAccountId}; skipping it`,
      );
      continue;
    }

    let master: Record<string, unknown>;
    if (link.master.kind === "MANAGER") {
      let broker;
      try {
        broker = getBroker(link.ownerUserId, link.master.brokerId);
      } catch {
        console.error(
          `[copier] link ${link.id} (${link.label}) points at broker ${link.master.brokerId}, which no longer exists; skipping it`,
        );
        continue;
      }
      master = {
        kind: "MANAGER",
        label: `${broker.name} ${link.master.login}`,
        server: broker.server,
        managerLogin: Number(broker.managerLogin),
        managerPassword: await decryptBrokerPassword(broker),
        account: link.master.login,
      };
    } else {
      const source = byId.get(link.master.accountId);
      if (!source) {
        console.error(
          `[copier] link ${link.id} (${link.label}) reads its master from account ${link.master.accountId}, which no longer exists; skipping it`,
        );
        continue;
      }
      master = {
        kind: "TERMINAL",
        label: `${source.label} (${source.login})`,
        accountId: source.id,
      };
    }

    usable.push(link);
    masters.push(master);
  }

  // Ship every account, linked or not. "Test login" and the symbol lookup in
  // the link form both run before any link exists, and the service answers
  // "no worker for account" for an account it was never sent. Its workers are
  // lazy, so an account with no link still never starts a terminal or attempts
  // a login until one of those is asked for.
  const payload: CopierServiceConfig["accounts"] = [];
  for (const account of accounts) {
    payload.push({
      id: account.id,
      label: `${account.label} (${account.login})`,
      server: account.server,
      login: account.login,
      password: await decryptSecret(account.encryptedPassword),
    });
  }

  return {
    accounts: payload,
    links: usable.map((link, index) => ({
      id: link.id,
      label: link.label,
      master: masters[index],
      destId: link.destAccountId,
      rules: link.rules,
      enabled: link.enabled,
      dryRun: link.dryRun,
      maxDrawdownPct: link.maxDrawdownPct,
      ownerId: link.ownerUserId,
    })),
  };
}
