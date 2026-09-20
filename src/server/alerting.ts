import { randomUUID } from "node:crypto";
import { getClientPositions } from "./brokers";
import { getBroker } from "./broker-store";
import { listAllMonitored, listMonitored, type MonitoredClient } from "./monitor-store";
import {
  appendAlert,
  readSnapshot,
  snapshotKey,
  writeSnapshot,
  type AlertPosition,
  type AlertType,
  type StoredAlert,
} from "./notification-store";
import { sendTelegramAlert } from "./telegram";
import type { SessionUser } from "./session";
import { getUserById } from "./user-store";
import { monitorPollIntervalMs } from "./env";

const same = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? null) === (b ?? null);

const asPosition = (value: unknown): AlertPosition => {
  const v = (value ?? {}) as Partial<AlertPosition>;
  return {
    positionId: String(v.positionId ?? ""),
    symbol: String(v.symbol ?? ""),
    direction: v.direction === "SELL" ? "SELL" : "BUY",
    volume: Number(v.volume ?? 0),
    openPrice: Number(v.openPrice ?? 0),
    currentPrice: v.currentPrice != null ? Number(v.currentPrice) : null,
    profit: Number(v.profit ?? 0),
    sl: v.sl != null ? Number(v.sl) : null,
    tp: v.tp != null ? Number(v.tp) : null,
    openedAt: v.openedAt != null ? String(v.openedAt) : null,
  };
};

declare global {
  var __mt5_poller_timer__: NodeJS.Timeout | undefined;
  var __mt5_poller_running__: boolean | undefined;
  var __mt5_recent_alerts__: Map<string, number> | undefined;
  var __mt5_active_client_polls__: Set<string> | undefined;
}

if (!globalThis.__mt5_recent_alerts__) {
  globalThis.__mt5_recent_alerts__ = new Map<string, number>();
}
if (!globalThis.__mt5_active_client_polls__) {
  globalThis.__mt5_active_client_polls__ = new Set<string>();
}

function isDuplicateAlert(fingerprint: string): boolean {
  const now = Date.now();
  const recent = globalThis.__mt5_recent_alerts__!;
  for (const [k, time] of recent.entries()) {
    if (now - time > 120_000) recent.delete(k);
  }
  const lastTime = recent.get(fingerprint);
  if (lastTime && now - lastTime < 60_000) {
    return true;
  }
  recent.set(fingerprint, now);
  return false;
}

async function alert(
  user: SessionUser,
  item: MonitoredClient,
  type: AlertType,
  position: AlertPosition,
  from?: number | null,
  to?: number | null,
  brokerName?: string,
) {
  const fingerprint = `${item.brokerId}:${item.login}:${type}:${position.positionId}:${from ?? ""}:${to ?? ""}`;
  if (isDuplicateAlert(fingerprint)) {
    console.log(`[MT5 Alerting] Suppressed duplicate alert: ${fingerprint}`);
    return;
  }

  const record: StoredAlert = {
    id: randomUUID(),
    userId: user.id,
    brokerId: item.brokerId,
    ...(brokerName ? { brokerName } : {}),
    type,
    clientLogin: String(item.login),
    clientName: item.clientName || `Login ${item.login}`,
    position,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    createdAt: new Date().toISOString(),
    telegram: "not_configured",
  };

  try {
    const tel = await sendTelegramAlert(record);
    record.telegram = tel.status;
    if (tel.error) {
      record.telegramError = tel.error;
    }
  } catch (err) {
    record.telegram = "failed";
    record.telegramError = err instanceof Error ? err.message : "Unknown telegram failure";
  }

  appendAlert(record);
}

export async function pollMonitoredClient(
  user: SessionUser,
  item: MonitoredClient,
): Promise<{ baseline: boolean; alerts: number; error?: boolean }> {
  const clientLockKey = snapshotKey(user.id, item.brokerId, item.login);
  const activePolls = globalThis.__mt5_active_client_polls__!;
  if (activePolls.has(clientLockKey)) {
    return { baseline: false, alerts: 0 };
  }
  activePolls.add(clientLockKey);

  try {
    let positionData;
    try {
      positionData = await getClientPositions(user, item.brokerId, String(item.login));
    } catch (error) {
      // CRITICAL: MT5 connector or read failure must NEVER be interpreted as positions closed!
      // Preserve previous snapshot and log warning safely without failing other accounts.
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MT5 Alerting] Could not fetch positions for login ${item.login} (broker ${item.brokerId}): ${msg}`,
      );
      return { baseline: false, alerts: 0, error: true };
    }

    let brokerName: string | undefined;
    try {
      const broker = getBroker(user.id, item.brokerId);
      brokerName = broker.name;
    } catch {
      // Non-critical fallback if broker not found in current user store
    }
    const current = positionData.positions.map(asPosition);
    const key = snapshotKey(user.id, item.brokerId, item.login);
    const previous = readSnapshot(key);

    // Baseline requirement: First time monitoring, store baseline and do NOT alert existing positions
    if (!previous) {
      writeSnapshot(key, current);
      return { baseline: true, alerts: 0 };
    }

    const before = new Map(previous.map((p) => [p.positionId, p]));
    const after = new Map(current.map((p) => [p.positionId, p]));
    let alerts = 0;

    // Detect new positions & modifications
    for (const position of current) {
      const old = before.get(position.positionId);
      if (!old) {
        // New position opened
        await alert(user, item, "new_position", position, undefined, undefined, brokerName);
        alerts++;
        continue;
      }

      const volumeChanged = old.volume !== position.volume;
      const slChanged = !same(old.sl, position.sl);
      const tpChanged = !same(old.tp, position.tp);

      // Deterministic classification without duplicate events
      if (slChanged && !tpChanged && !volumeChanged) {
        // Only SL changed
        await alert(user, item, "sl_modified", position, old.sl, position.sl, brokerName);
        alerts++;
      } else if (tpChanged && !slChanged && !volumeChanged) {
        // Only TP changed
        await alert(user, item, "tp_modified", position, old.tp, position.tp, brokerName);
        alerts++;
      } else if (volumeChanged && !slChanged && !tpChanged) {
        // Only volume modified
        await alert(
          user,
          item,
          "position_modified",
          position,
          old.volume,
          position.volume,
          brokerName,
        );
        alerts++;
      } else if (volumeChanged || slChanged || tpChanged) {
        // Multiple parameters changed simultaneously -> single position_modified notification
        await alert(
          user,
          item,
          "position_modified",
          position,
          old.volume,
          position.volume,
          brokerName,
        );
        alerts++;
      }
    }

    // Detect closed positions
    for (const position of previous) {
      if (!after.has(position.positionId)) {
        await alert(user, item, "position_closed", position, undefined, undefined, brokerName);
        alerts++;
      }
    }

    writeSnapshot(key, current);
    return { baseline: false, alerts };
  } finally {
    activePolls.delete(clientLockKey);
  }
}

const lastPoll = new Map<string, number>();

export async function pollAlertsForUser(user: SessionUser, force = false) {
  const now = Date.now();
  const last = lastPoll.get(user.id) ?? 0;
  if (!force && now - last < monitorPollIntervalMs()) {
    return { checked: 0, alerts: 0, skipped: true };
  }
  lastPoll.set(user.id, now);

  const monitoredList = listMonitored(user.id);
  let totalAlerts = 0;

  // Process clients sequentially to respect MT5 Manager single-session serialization
  for (const item of monitoredList) {
    try {
      const res = await pollMonitoredClient(user, item);
      totalAlerts += res.alerts;
    } catch (err) {
      console.error(`[MT5 Alerting] Uncaught error polling client ${item.login}:`, err);
    }
  }

  return { checked: monitoredList.length, alerts: totalAlerts, skipped: false };
}

// Users already reported as skipped, so a long outage doesn't spam the log every cycle.
const skippedUsers = new Set<string>();

export async function pollAllAlerts() {
  const items = listAllMonitored();
  const users = new Map<string, SessionUser>();
  for (const item of items) {
    if (users.has(item.userId)) continue;
    // Poll only for accounts that are active and still allowed to monitor. A suspended, deleted or
    // pending account (or one with monitoring revoked) stops generating alerts.
    const live = getUserById(item.userId);
    if (!live || live.status !== "ACTIVE" || live.permissions?.canMonitorClients === false) {
      if (!skippedUsers.has(item.userId)) {
        skippedUsers.add(item.userId);
        console.warn(
          `[MT5 Alerting] Not polling clients of user ${item.userId}: account missing, inactive or monitoring revoked.`,
        );
      }
      continue;
    }
    skippedUsers.delete(item.userId);
    users.set(item.userId, {
      id: live.id,
      email: live.email,
      name: live.name,
      username: live.username,
      role: live.role,
      status: live.status,
    });
  }

  let totalAlerts = 0;
  for (const user of users.values()) {
    try {
      const res = await pollAlertsForUser(user, true);
      totalAlerts += res.alerts;
    } catch (err) {
      console.error(`[MT5 Alerting] Polling error for user ${user.id}:`, err);
    }
  }

  return { checkedUsers: users.size, alerts: totalAlerts };
}

export function startBackgroundPoller(): void {
  // CRITICAL: Clear any existing poller across module reloads, HMR, or re-invocations
  if (globalThis.__mt5_poller_timer__) {
    clearInterval(globalThis.__mt5_poller_timer__);
    globalThis.__mt5_poller_timer__ = undefined;
  }

  const intervalMs = monitorPollIntervalMs();
  console.log(
    `[MT5 Alerting] Initializing singleton background poller (interval: ${intervalMs / 1000}s)`,
  );

  const runCycle = async () => {
    if (globalThis.__mt5_poller_running__) return;
    globalThis.__mt5_poller_running__ = true;
    try {
      await pollAllAlerts();
    } catch (err) {
      console.error("[MT5 Alerting] Background polling cycle failure:", err);
    } finally {
      globalThis.__mt5_poller_running__ = false;
    }
  };

  // Run initial cycle immediately after launch
  setTimeout(() => {
    void runCycle();
  }, 500);

  const timer = setInterval(() => {
    void runCycle();
  }, intervalMs);

  globalThis.__mt5_poller_timer__ = timer;
}
