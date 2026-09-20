import { getClient, getClientPositions } from "./brokers";
import { addMonitored, listMonitored, removeMonitored } from "./monitor-store";
import type { SessionUser } from "./session";

import { pollMonitoredClient } from "./alerting";

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 15_000;

export async function monitorClient(user: SessionUser, brokerId: string, login: number) {
  const client = await getClient(user, brokerId, String(login));
  addMonitored(user.id, brokerId, login, client.name);
  cache.delete(user.id);
  // Establish immediate baseline snapshot so existing positions don't emit false alerts
  void pollMonitoredClient(user, {
    userId: user.id,
    brokerId,
    login,
    clientName: client.name,
    createdAt: new Date().toISOString(),
  });
}
export function unmonitorClient(user: SessionUser, brokerId: string, login: number) {
  removeMonitored(user.id, brokerId, login);
  cache.delete(user.id);
}
export function isMonitored(user: SessionUser, brokerId: string, login: number) {
  return listMonitored(user.id).some((item) => item.brokerId === brokerId && item.login === login);
}
export async function liveMonitoredClients(user: SessionUser) {
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const saved = listMonitored(user.id);
  const clients = await Promise.all(
    saved.map(async (item) => {
      try {
        const [client, positionData] = await Promise.all([
          getClient(user, item.brokerId, String(item.login)),
          getClientPositions(user, item.brokerId, String(item.login)),
        ]);
        return { ...client, positions: positionData.positions, unavailable: false };
      } catch (error) {
        return {
          brokerId: item.brokerId,
          login: item.login,
          name: `Login ${item.login}`,
          positions: [],
          unavailable: true,
          message: error instanceof Error ? error.message : "Data unavailable",
        };
      }
    }),
  );
  const value = { clients, refreshedAt: new Date().toISOString(), refreshAfterSeconds: 15 };
  cache.set(user.id, { at: Date.now(), value });
  return value;
}
