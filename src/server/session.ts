import { ApiError } from "./errors";
import { env } from "./env";
import {
  findUserByEmailOrUsername,
  getUserById,
  recordUserLogin,
  verifyPassword,
  type UserRole,
  type UserStatus,
} from "./user-store";
import { logAudit } from "./audit-store";

const COOKIE = "mt5_monitor_session";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  username: string;
  role: UserRole;
  status: UserStatus;
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
    return {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      username: payload.username || payload.email.split("@")[0] || "",
      role: payload.role || "USER",
      status: payload.status || "ACTIVE",
    };
  } catch {
    return null;
  }
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const session = await readSession(request);
  if (!session) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);

  // Validate live status from user database
  const live = getUserById(session.id);
  if (!live || live.status === "DELETED") {
    throw new ApiError("UNAUTHORIZED", "Account not found or deleted.", 401);
  }
  if (live.status === "PENDING") {
    throw new ApiError("FORBIDDEN", "Your account is awaiting approval.", 403);
  }
  if (live.status === "SUSPENDED") {
    throw new ApiError("FORBIDDEN", "Your account has been suspended.", 403);
  }
  if (live.role === "USER" && !live.permissions?.canLogin) {
    throw new ApiError("FORBIDDEN", "Login permission has been revoked for this account.", 403);
  }

  return {
    id: live.id,
    email: live.email,
    name: live.name,
    username: live.username,
    role: live.role,
    status: live.status,
  };
}

export async function requireAdmin(request: Request): Promise<SessionUser> {
  const user = await requireUser(request);
  if (user.role !== "ADMIN") {
    throw new ApiError("FORBIDDEN", "Administrative privilege required.", 403);
  }
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

export function authenticateUser(
  identifier: string,
  password: string,
  requiredRole?: UserRole,
  ipAddress?: string,
): SessionUser {
  const cleanId = (identifier || "").trim();
  const found = findUserByEmailOrUsername(cleanId);

  if (!found || !verifyPassword(password, found.passwordHash)) {
    logAudit({
      actorId: found?.id || "anonymous",
      actorEmail: cleanId,
      actorRole: found?.role || "USER",
      action: "USER_LOGIN_FAILED",
      targetType: "USER",
      targetId: found?.id,
      details: { reason: "INVALID_CREDENTIALS" },
      ipAddress,
    });
    throw new ApiError("UNAUTHORIZED", "Invalid email/username or password.", 401);
  }

  if (found.status === "PENDING") {
    logAudit({
      actorId: found.id,
      actorEmail: found.email,
      actorRole: found.role,
      action: "USER_LOGIN_FAILED",
      targetType: "USER",
      targetId: found.id,
      details: { reason: "ACCOUNT_PENDING" },
      ipAddress,
    });
    throw new ApiError(
      "ACCOUNT_PENDING",
      "Your account is pending administrator approval. Please wait for an administrator to activate your account.",
      403,
    );
  }

  if (found.status === "SUSPENDED") {
    logAudit({
      actorId: found.id,
      actorEmail: found.email,
      actorRole: found.role,
      action: "USER_LOGIN_FAILED",
      targetType: "USER",
      targetId: found.id,
      details: { reason: "ACCOUNT_SUSPENDED" },
      ipAddress,
    });
    throw new ApiError(
      "ACCOUNT_SUSPENDED",
      "Your account has been suspended. Please contact an administrator.",
      403,
    );
  }

  if (found.status === "DELETED") {
    throw new ApiError("ACCOUNT_DELETED", "This account has been deleted.", 403);
  }

  if (found.role === "USER" && !found.permissions.canLogin) {
    throw new ApiError("LOGIN_DISABLED", "Login access has been revoked for this account.", 403);
  }

  if (requiredRole && found.role !== requiredRole) {
    if (requiredRole === "ADMIN") {
      logAudit({
        actorId: found.id,
        actorEmail: found.email,
        actorRole: found.role,
        action: "USER_LOGIN_FAILED",
        targetType: "USER",
        targetId: found.id,
        details: { reason: "ROLE_MISMATCH_EXPECTED_ADMIN" },
        ipAddress,
      });
      throw new ApiError(
        "FORBIDDEN",
        "Administrative privilege required. Please use the Client Login tab.",
        403,
      );
    }
  }

  recordUserLogin(found.id);
  logAudit({
    actorId: found.id,
    actorEmail: found.email,
    actorRole: found.role,
    action: "USER_LOGIN",
    targetType: "USER",
    targetId: found.id,
    details: { role: found.role },
    ipAddress,
  });

  return {
    id: found.id,
    email: found.email,
    name: found.name,
    username: found.username,
    role: found.role,
    status: found.status,
  };
}

export function authenticateLocal(email: string, password: string): SessionUser {
  return authenticateUser(email, password);
}
