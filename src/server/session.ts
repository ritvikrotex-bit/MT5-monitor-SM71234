import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ApiError } from "./errors";
import { env, envOptional } from "./env";
import { dataFile } from "./paths";

const COOKIE = "mt5_monitor_session";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

type SessionPayload = SessionUser & { exp: number };

function sessionSecret(): string {
  return env("MONITOR_SESSION_SECRET");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToHex(sig);
}

function b64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(text: string): string {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  const payload: SessionPayload = {
    ...user,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await sign(body);
  return `${body}.${sig}`;
}

export async function readSession(request: Request): Promise<SessionUser | null> {
  const header = request.headers.get("cookie") ?? "";
  const match = header
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const token = match.slice(COOKIE.length + 1);
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await sign(body);
  if (expected.length !== sig.length) return null;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (ok !== 0) return null;
  try {
    const payload = JSON.parse(fromB64url(body)) as SessionPayload;
    if (payload.exp < Date.now()) return null;
    return { id: payload.id, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await readSession(request);
  if (!user) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
  return user;
}

// Behind Caddy the app sees plain HTTP; the proxy reports the real scheme in X-Forwarded-Proto.
function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return (forwarded ?? new URL(request.url).protocol.replace(":", "")) === "https";
}

export function sessionCookie(token: string, request: Request): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secure}`;
}

export function clearSessionCookie(request: Request): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

type StoredUser = {
  email: string;
  password: string;
  name: string;
  id: string;
};

// Operator accounts come from data/users.json and the optional MONITOR_AUTH_EMAIL/PASSWORD env pair.
function getUsers(): StoredUser[] {
  const users: StoredUser[] = [];

  // data/users.json (hand-edited, so tolerate a UTF-8 BOM from Windows editors/PowerShell)
  try {
    const file = dataFile("users.json");
    if (existsSync(file)) {
      const text = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(text) as Partial<StoredUser>[];
      if (Array.isArray(parsed)) {
        for (const u of parsed) {
          if (
            u.email &&
            u.password &&
            !users.some((x) => x.email.toLowerCase() === u.email!.toLowerCase())
          ) {
            users.push({
              email: u.email,
              password: u.password,
              name: u.name || u.email.split("@")[0] || "Operator",
              id: "local-operator",
            });
          }
        }
      }
    }
  } catch (error) {
    // Never fail silently: a broken users.json means nobody can log in.
    console.error("[MT5 Auth] Could not read data/users.json:", error);
  }

  const envEmail = envOptional("MONITOR_AUTH_EMAIL");
  const envPassword = envOptional("MONITOR_AUTH_PASSWORD");
  if (
    envEmail &&
    envPassword &&
    !users.some((u) => u.email.toLowerCase() === envEmail.toLowerCase())
  ) {
    users.push({
      email: envEmail,
      password: envPassword,
      name: envEmail.split("@")[0] || "Operator",
      id: "local-operator",
    });
  }

  return users;
}

// Hash both sides so the comparison is constant-time regardless of length.
function passwordMatches(stored: string, supplied: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(stored), digest(supplied));
}

export function authenticateLocal(email: string, password: string): SessionUser {
  const users = getUsers();
  const normalized = email.trim().toLowerCase();
  const found = users.find(
    (u) => u.email.trim().toLowerCase() === normalized && passwordMatches(u.password, password),
  );
  if (!found) {
    throw new ApiError("UNAUTHORIZED", "Invalid email or password.", 401);
  }
  return { id: found.id, email: found.email, name: found.name };
}
