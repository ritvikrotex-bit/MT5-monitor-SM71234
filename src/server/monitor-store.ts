import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
const read = (): MonitoredClient[] =>
  existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as Store).monitored || [] : [];
const write = (monitored: MonitoredClient[]) => {
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify({ monitored }, null, 2), "utf8");
};

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
    all.push({ userId, brokerId, login, clientName, createdAt: new Date().toISOString() });
    write(all);
  }
};
export const removeMonitored = (userId: string, brokerId: string, login: number) =>
  write(
    read().filter(
      (item) => item.userId !== userId || item.brokerId !== brokerId || item.login !== login,
    ),
  );
