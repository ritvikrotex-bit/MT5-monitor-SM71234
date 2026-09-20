export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export type Broker = {
  id: string;
  name: string;
  server: string;
  status: ConnectionStatus;
  managerLogin: string;
  password?: string;
  lastUpdate: string;
};

export type Position = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  openPrice: number;
  currentPrice: number;
  tp: number | null;
  sl: number | null;
  pl: number;
  openedAt: string;
};

export type Client = {
  login: string;
  name: string;
  brokerId: string;
  group: string;
  balance: number;
  equity: number;
  margin: number;
  floating: number;
  currency: string;
  positions: Position[];
};

export type NotificationType =
  "new_position" | "position_closed" | "position_modified" | "sl_modified" | "tp_modified";

export type TradeNotification = {
  id: string;
  type: NotificationType;
  clientLogin: string;
  clientName: string;
  brokerId: string;
  brokerName?: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  price?: number;
  tp?: number | null;
  sl?: number | null;
  from?: number;
  to?: number;
  pl?: number;
  positionId?: string;
  minutesAgo: number;
  time: string;
  day: "today" | "yesterday";
};

export function toTradeNotification(alert: {
  id: string;
  type: NotificationType;
  clientLogin: string;
  clientName: string;
  brokerId: string;
  brokerName?: string;
  position?: {
    symbol?: string;
    direction?: "BUY" | "SELL";
    volume?: number;
    openPrice?: number;
    profit?: number;
    sl?: number | null;
    tp?: number | null;
    positionId?: string;
  };
  from?: number | null;
  to?: number | null;
  createdAt: string;
}): TradeNotification {
  const at = new Date(alert.createdAt);
  const minutesAgo = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  const isToday = new Date().toDateString() === at.toDateString();
  const pos = alert.position || {};
  return {
    id: alert.id,
    type: alert.type,
    clientLogin: alert.clientLogin,
    clientName: alert.clientName,
    brokerId: alert.brokerId,
    ...(alert.brokerName ? { brokerName: alert.brokerName } : {}),
    symbol: pos.symbol || "UNKNOWN",
    side: pos.direction === "SELL" ? "SELL" : "BUY",
    lots: Number(pos.volume ?? 0),
    price: Number(pos.openPrice ?? 0),
    tp: pos.tp != null ? Number(pos.tp) : null,
    sl: pos.sl != null ? Number(pos.sl) : null,
    ...(alert.from != null ? { from: Number(alert.from) } : {}),
    ...(alert.to != null ? { to: Number(alert.to) } : {}),
    pl: Number(pos.profit ?? 0),
    ...(pos.positionId ? { positionId: String(pos.positionId) } : {}),
    minutesAgo,
    time: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    day: isToday ? "today" : "yesterday",
  };
}

export const notificationMeta: Record<
  NotificationType,
  { label: string; tone: "positive" | "negative" | "warning" | "neutral" }
> = {
  new_position: { label: "New Position", tone: "positive" },
  position_closed: { label: "Position Closed", tone: "neutral" },
  position_modified: { label: "Position Modified", tone: "warning" },
  sl_modified: { label: "SL Modified", tone: "warning" },
  tp_modified: { label: "TP Modified", tone: "warning" },
};

export const money = (v: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(v);

export const signedMoney = (v: number, currency = "USD") =>
  `${v > 0 ? "+" : v < 0 ? "-" : ""}${money(Math.abs(v), currency)}`;

export const price = (v: number) => (v >= 1000 ? v.toFixed(2) : v.toFixed(5));

export const ago = (m: number) => {
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};
