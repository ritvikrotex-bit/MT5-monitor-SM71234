import {
  connectorConnect,
  connectorDisconnect,
  connectorGetAccount,
  connectorGetPositions,
  connectorSearch,
  connectorStatus,
  connectorTest,
} from "./connector-client";
import {
  createBroker,
  decryptBrokerPassword,
  deleteBroker,
  getBroker,
  getPublicBroker,
  listBrokers,
  setBrokerStatus,
  updateBroker,
  type PublicBroker,
} from "./broker-store";
import { ApiError } from "./errors";
import type { SessionUser } from "./session";

async function credsFor(userId: string, brokerId: string) {
  const broker = getBroker(userId, brokerId);
  if (!/^\d+$/.test(broker.managerLogin.trim())) {
    throw new ApiError(
      "INVALID_BROKER",
      "Manager login must be a numeric MT5 Manager account ID.",
      400,
    );
  }
  const password = await decryptBrokerPassword(broker);
  return {
    broker,
    creds: {
      server: broker.server,
      login: Number.parseInt(broker.managerLogin, 10),
      password,
    },
  };
}

export function listUserBrokers(user: SessionUser): PublicBroker[] {
  return listBrokers(user.id);
}

export async function addUserBroker(
  user: SessionUser,
  input: { name: string; server: string; managerLogin: string; password: string },
) {
  if (!input.name.trim() || !input.server.trim() || !input.managerLogin.trim() || !input.password) {
    throw new ApiError(
      "INVALID_BROKER",
      "Broker name, server, manager login and password are required.",
      400,
    );
  }
  if (!/^\d+$/.test(input.managerLogin.trim())) {
    throw new ApiError(
      "INVALID_BROKER",
      "Manager login must be a numeric MT5 Manager account ID.",
      400,
    );
  }
  return createBroker(user.id, input);
}

export function getUserBroker(user: SessionUser, id: string) {
  return getPublicBroker(user.id, id);
}

export async function patchUserBroker(
  user: SessionUser,
  id: string,
  patch: { name?: string; server?: string; managerLogin?: string; password?: string },
) {
  return updateBroker(user.id, id, patch);
}

export async function removeUserBroker(user: SessionUser, id: string) {
  const { creds } = await credsFor(user.id, id);
  try {
    await connectorDisconnect(creds);
  } catch {
    // Connector may be down; still delete the saved configuration.
  }
  deleteBroker(user.id, id);
}

export async function testSavedBroker(user: SessionUser, id: string) {
  const { creds } = await credsFor(user.id, id);
  setBrokerStatus(user.id, id, "CONNECTING", "Testing Manager connection.");
  try {
    const result = await connectorTest(creds);
    const status = result.ok ? "CONNECTED" : "ERROR";
    return setBrokerStatus(user.id, id, status, result.message);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Connection failed.";
    const status =
      error instanceof ApiError && error.code === "INVALID_CREDENTIALS" ? "ERROR" : "ERROR";
    return setBrokerStatus(user.id, id, status, message);
  }
}

export async function brokerStatus(user: SessionUser, id: string) {
  const { creds } = await credsFor(user.id, id);
  try {
    const result = await connectorStatus(creds);
    return setBrokerStatus(user.id, id, result.status, result.message);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Status unavailable.";
    return setBrokerStatus(user.id, id, "ERROR", message);
  }
}

export async function connectBroker(user: SessionUser, id: string) {
  const { creds } = await credsFor(user.id, id);
  const result = await connectorConnect(creds);
  return setBrokerStatus(user.id, id, result.status, result.message);
}

function detectBy(query: string, requested?: string | null): "login" | "name" | "group" | "auto" {
  if (requested === "login" || requested === "name" || requested === "group") return requested;
  return "auto";
}

export async function searchClients(
  user: SessionUser,
  brokerId: string,
  query: string,
  by?: string | null,
) {
  const { creds } = await credsFor(user.id, brokerId);
  const result = await connectorSearch(creds, query, detectBy(query, by));
  return {
    brokerId,
    clients: result.clients.map((c) => ({
      login: c.login,
      name: c.name,
      brokerId,
      group: c.group ?? undefined,
      balance: c.balance ?? undefined,
      equity: c.equity ?? undefined,
      margin: c.margin ?? undefined,
      floatingProfit: c.floatingProfit ?? undefined,
      leverage: c.leverage ?? undefined,
      currency: c.currency ?? undefined,
    })),
  };
}

export async function getClient(user: SessionUser, brokerId: string, login: string) {
  const account = Number.parseInt(login, 10);
  if (!Number.isFinite(account)) {
    throw new ApiError("CLIENT_NOT_FOUND", "No client matched that login.", 404);
  }
  const { creds } = await credsFor(user.id, brokerId);
  try {
    const result = await connectorGetAccount(creds, account);
    const c = result.client;
    return {
      login: c.login,
      name: c.name,
      brokerId,
      group: c.group ?? undefined,
      balance: c.balance ?? undefined,
      equity: c.equity ?? undefined,
      margin: c.margin ?? undefined,
      floatingProfit: c.floatingProfit ?? undefined,
      leverage: c.leverage ?? undefined,
      currency: c.currency ?? undefined,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError("CLIENT_NOT_FOUND", "No client matched that login.", 404);
    }
    throw error;
  }
}

export async function getClientPositions(user: SessionUser, brokerId: string, login: string) {
  const account = Number.parseInt(login, 10);
  if (!Number.isFinite(account)) {
    throw new ApiError("CLIENT_NOT_FOUND", "No client matched that login.", 404);
  }
  const { creds } = await credsFor(user.id, brokerId);
  try {
    const result = await connectorGetPositions(creds, account);
    return {
      clientLogin: result.clientLogin,
      slTpAvailable: result.slTpAvailable,
      positions: result.positions,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError("CLIENT_NOT_FOUND", "No client matched that login.", 404);
    }
    throw new ApiError(
      "DATA_UNAVAILABLE",
      error instanceof ApiError ? error.message : "Open positions are currently unavailable.",
      502,
    );
  }
}
