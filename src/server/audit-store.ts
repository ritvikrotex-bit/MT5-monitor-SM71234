import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isPostgresConfigured, query } from "./db";
import { dataFile } from "./paths";

export type AuditLogAction =
  | "USER_LOGIN"
  | "USER_LOGOUT"
  | "USER_LOGIN_FAILED"
  | "USER_SIGNUP"
  | "USER_STATUS_CHANGE"
  | "USER_PERMISSIONS_UPDATE"
  | "USER_LIMITS_UPDATE"
  | "USER_DELETE"
  | "BROKER_CREATE"
  | "BROKER_UPDATE"
  | "BROKER_DELETE"
  | "BROKER_CONNECT"
  | "BROKER_DISCONNECT"
  | "BROKER_STATUS_TOGGLE"
  | "MONITOR_ADD"
  | "MONITOR_REMOVE"
  | "TELEGRAM_CONFIG_UPDATE"
  | "NOTIFICATION_TRIGGERED"
  | "SYSTEM_INIT";

export type AuditLogEntry = {
  id: string;
  timestamp: string;
  actorId: string;
  actorEmail: string;
  actorRole: "ADMIN" | "USER" | "SYSTEM";
  action: AuditLogAction | string;
  targetType: "USER" | "BROKER" | "MONITOR" | "SYSTEM" | "NOTIFICATION";
  targetId?: string | undefined;
  details?: Record<string, unknown> | undefined;
  ipAddress?: string | undefined;
};

function auditFilePath(): string {
  return dataFile("audit.json");
}

function sanitizeDetails(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const sensitiveRegex = /(password|token|secret|key|authorization|cookie)/i;

  const sanitize = (val: unknown): unknown => {
    if (val === null || val === undefined) return val;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(sanitize);
    }
    if (typeof val === "object") {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (sensitiveRegex.test(k)) {
          copy[k] = "[REDACTED]";
        } else {
          copy[k] = sanitize(v);
        }
      }
      return copy;
    }
    return String(val);
  };

  return sanitize(data) as Record<string, unknown>;
}

let memoryLogs: AuditLogEntry[] | null = null;

function readAllAuditLogs(): AuditLogEntry[] {
  if (memoryLogs) return memoryLogs;

  const path = auditFilePath();
  if (!existsSync(path)) {
    memoryLogs = [];
    return memoryLogs;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    memoryLogs = Array.isArray(parsed) ? parsed : [];
    return memoryLogs;
  } catch {
    memoryLogs = [];
    return memoryLogs;
  }
}

function writeAllAuditLogs(logs: AuditLogEntry[]): void {
  memoryLogs = logs;
  const path = auditFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(logs, null, 2), "utf8");
}

// Hydrate audit logs from PostgreSQL on startup if enabled
if (isPostgresConfigured()) {
  void (async () => {
    try {
      // PostgreSQL rows are untyped snake_case records; mapped explicitly below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await query<any>("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 5000");
      if (rows && rows.length > 0) {
        memoryLogs = rows.map((r) => ({
          id: r.id,
          timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString(),
          actorId: r.actor_id,
          actorEmail: r.actor_email,
          actorRole: r.actor_role,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id || undefined,
          details: typeof r.details === "string" ? JSON.parse(r.details) : r.details || undefined,
          ipAddress: r.ip_address || undefined,
        }));
      }
    } catch (err) {
      console.error("[PostgreSQL] Hydration error for audit logs:", err);
    }
  })();
}

export function logAudit(entry: {
  actorId: string;
  actorEmail: string;
  actorRole: "ADMIN" | "USER" | "SYSTEM";
  action: AuditLogAction | string;
  targetType: "USER" | "BROKER" | "MONITOR" | "SYSTEM" | "NOTIFICATION";
  targetId?: string | undefined;
  details?: Record<string, unknown> | undefined;
  ipAddress?: string | undefined;
}): AuditLogEntry {
  const fullEntry: AuditLogEntry = {
    id: "aud-" + randomUUID().slice(0, 12),
    timestamp: new Date().toISOString(),
    actorId: entry.actorId,
    actorEmail: entry.actorEmail,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: sanitizeDetails(entry.details),
    ipAddress: entry.ipAddress,
  };

  const logs = readAllAuditLogs();
  logs.unshift(fullEntry);
  if (logs.length > 5000) {
    logs.splice(5000);
  }

  writeAllAuditLogs(logs);

  if (isPostgresConfigured()) {
    void query(
      `INSERT INTO audit_logs (id, timestamp, actor_id, actor_email, actor_role, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING;`,
      [
        fullEntry.id,
        new Date(fullEntry.timestamp),
        fullEntry.actorId,
        fullEntry.actorEmail,
        fullEntry.actorRole,
        fullEntry.action,
        fullEntry.targetType,
        fullEntry.targetId || null,
        JSON.stringify(fullEntry.details || {}),
        fullEntry.ipAddress || null,
      ],
    ).catch((err) => console.error("[PostgreSQL] Audit sync error:", err));
  }

  return fullEntry;
}

export const getRecentAuditLogs = (limit = 10): AuditLogEntry[] => listAuditLogs({ limit }).logs;

export function listAuditLogs(options?: {
  limit?: number;
  offset?: number;
  actorId?: string;
  action?: string;
  targetType?: string;
}): { logs: AuditLogEntry[]; total: number } {
  let all = readAllAuditLogs();

  if (options?.actorId) {
    all = all.filter((l) => l.actorId === options.actorId);
  }
  if (options?.action) {
    all = all.filter((l) => l.action === options.action);
  }
  if (options?.targetType) {
    all = all.filter((l) => l.targetType === options.targetType);
  }

  const total = all.length;
  const offset = Math.max(0, options?.offset ?? 0);
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
  const logs = all.slice(offset, offset + limit);

  return { logs, total };
}
