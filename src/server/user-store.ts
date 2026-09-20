import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import { isPostgresConfigured, query } from "./db";
import { dataFile } from "./paths";

export type UserRole = "ADMIN" | "USER";
export type UserStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "DELETED";

export type UserPermissions = {
  canLogin: boolean;
  canAddBroker: boolean;
  canConnectBroker: boolean;
  canMonitorClients: boolean;
  canUseTelegram: boolean;
  canUseEmail: boolean;
  canUsePush: boolean;
};

export type UserLimits = {
  maxBrokers: number;
  maxMonitoredClients: number;
};

export type StoredUser = {
  id: string;
  name: string;
  email: string;
  username: string;
  passwordHash: string; // format: salt:key
  role: UserRole;
  status: UserStatus;
  permissions: UserPermissions;
  limits: UserLimits;
  createdAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  lastLoginAt?: string | null;
  suspendedAt?: string | null;
  deletedAt?: string | null;
};

export type PublicUser = Omit<StoredUser, "passwordHash">;

type UserFileShape = {
  users: StoredUser[];
};

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  canLogin: true,
  canAddBroker: true,
  canConnectBroker: true,
  canMonitorClients: true,
  canUseTelegram: true,
  canUseEmail: true,
  canUsePush: true,
};

export const DEFAULT_USER_LIMITS: UserLimits = {
  maxBrokers: 5,
  maxMonitoredClients: 25,
};

export const ADMIN_PERMISSIONS: UserPermissions = {
  canLogin: true,
  canAddBroker: false, // Admin does not connect/add brokers for itself
  canConnectBroker: false,
  canMonitorClients: false,
  canUseTelegram: true,
  canUseEmail: true,
  canUsePush: true,
};

export const ADMIN_LIMITS: UserLimits = {
  maxBrokers: 0,
  maxMonitoredClients: 0,
};

function usersFilePath(): string {
  return dataFile("users.json");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${key}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  try {
    const keyBuffer = Buffer.from(key, "hex");
    const derived = scryptSync(password, salt, 64);
    return timingSafeEqual(keyBuffer, derived);
  } catch {
    return false;
  }
}

export function publicUser(user: StoredUser): PublicUser {
  const { passwordHash: _hidden, ...rest } = user;
  return rest;
}

// In-memory cache to guarantee sub-millisecond synchronous reads
let memoryUsers: StoredUser[] | null = null;

function readAllUsers(): StoredUser[] {
  if (memoryUsers) return memoryUsers;

  const path = usersFilePath();
  if (!existsSync(path)) {
    memoryUsers = [];
    return memoryUsers;
  }
  try {
    const content = readFileSync(path, "utf8").replace(/^\uFEFF/, ""); // tolerate a Windows BOM
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      memoryUsers = parsed as StoredUser[];
    } else if (parsed && Array.isArray((parsed as UserFileShape).users)) {
      memoryUsers = (parsed as UserFileShape).users;
    } else {
      memoryUsers = [];
    }
    return memoryUsers;
  } catch {
    memoryUsers = [];
    return memoryUsers;
  }
}

function syncUserToPostgres(u: StoredUser): void {
  if (!isPostgresConfigured()) return;
  void query(
    `INSERT INTO users (
      id, name, email, username, password_hash, role, status,
      permissions, limits, created_at, approved_at, approved_by,
      last_login_at, suspended_at, deleted_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      permissions = EXCLUDED.permissions,
      limits = EXCLUDED.limits,
      approved_at = EXCLUDED.approved_at,
      approved_by = EXCLUDED.approved_by,
      last_login_at = EXCLUDED.last_login_at,
      suspended_at = EXCLUDED.suspended_at,
      deleted_at = EXCLUDED.deleted_at;`,
    [
      u.id,
      u.name,
      u.email.toLowerCase(),
      u.username,
      u.passwordHash,
      u.role,
      u.status,
      JSON.stringify(u.permissions),
      JSON.stringify(u.limits),
      u.createdAt ? new Date(u.createdAt) : new Date(),
      u.approvedAt ? new Date(u.approvedAt) : null,
      u.approvedBy || null,
      u.lastLoginAt ? new Date(u.lastLoginAt) : null,
      u.suspendedAt ? new Date(u.suspendedAt) : null,
      u.deletedAt ? new Date(u.deletedAt) : null,
    ],
  ).catch((err) => console.error("[PostgreSQL] User sync error:", err));
}

function writeAllUsers(users: StoredUser[]): void {
  memoryUsers = users;
  const path = usersFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(users, null, 2), "utf8");

  if (isPostgresConfigured()) {
    for (const u of users) {
      syncUserToPostgres(u);
    }
  }
}

// Global initialization lock
let initialized = false;

export function ensureInitialUsers(): void {
  if (initialized) return;
  initialized = true;

  const users = readAllUsers();
  let changed = false;

  // 1. Ensure administrator exists
  // Uses environment variable INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD if supplied on VPS.
  const envAdminEmail = (process.env["INITIAL_ADMIN_EMAIL"] || "").trim().toLowerCase();
  const existingAdmin = users.find(
    (u) => u.role === "ADMIN" || (envAdminEmail && u.email.toLowerCase() === envAdminEmail),
  );

  const envAdminPass = process.env["INITIAL_ADMIN_PASSWORD"] || "";
  if (!existingAdmin && (!envAdminEmail || !envAdminPass)) {
    // No built-in default admin: a known default login on an internet-facing site is never acceptable.
    console.error(
      "[MT5 Auth] No administrator account exists. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD (or add an ADMIN to data/users.json).",
    );
  }
  if (!existingAdmin && envAdminEmail && envAdminPass) {
    const adminEmail = envAdminEmail;
    const adminPass = envAdminPass;
    const adminName = process.env["INITIAL_ADMIN_NAME"] || "Administrator";
    const now = new Date().toISOString();
    users.unshift({
      id: "admin-" + randomUUID().slice(0, 8),
      name: adminName,
      email: adminEmail,
      username: adminEmail.split("@")[0] || "admin",
      passwordHash: hashPassword(adminPass),
      role: "ADMIN",
      status: "ACTIVE",
      permissions: ADMIN_PERMISSIONS,
      limits: ADMIN_LIMITS,
      createdAt: now,
      approvedAt: now,
      approvedBy: "SYSTEM",
    });
    changed = true;
  }

  // 2. Ensure initial operator user exists
  const envOpEmail = (process.env["INITIAL_OPERATOR_EMAIL"] || "").trim().toLowerCase();
  const opUser = users.find(
    (u) => u.id === "local-operator" || (envOpEmail && u.email.toLowerCase() === envOpEmail),
  );

  if (!opUser && envOpEmail && process.env["INITIAL_OPERATOR_PASSWORD"]) {
    const now = new Date().toISOString();
    users.push({
      id: "local-operator",
      name: "Operator",
      email: envOpEmail,
      username: envOpEmail.split("@")[0] || "operator",
      passwordHash: hashPassword(process.env["INITIAL_OPERATOR_PASSWORD"]),
      role: "USER",
      status: "ACTIVE",
      permissions: DEFAULT_USER_PERMISSIONS,
      limits: DEFAULT_USER_LIMITS,
      createdAt: now,
      approvedAt: now,
      approvedBy: "SYSTEM",
    });
    changed = true;
  }

  if (changed) {
    writeAllUsers(users);
  }
}

// Initial check on module load
ensureInitialUsers();

// Asynchronous background hydration from PostgreSQL if enabled
if (isPostgresConfigured()) {
  void (async () => {
    try {
      // PostgreSQL rows are untyped snake_case records; mapped explicitly below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await query<any>("SELECT * FROM users ORDER BY created_at ASC");
      if (rows && rows.length > 0) {
        memoryUsers = rows.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          username: r.username,
          passwordHash: r.password_hash,
          role: r.role,
          status: r.status,
          permissions:
            typeof r.permissions === "string" ? JSON.parse(r.permissions) : r.permissions,
          limits: typeof r.limits === "string" ? JSON.parse(r.limits) : r.limits,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
          approvedBy: r.approved_by,
          lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
          suspendedAt: r.suspended_at ? new Date(r.suspended_at).toISOString() : null,
          deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
        }));
      }
    } catch (err) {
      console.error("[PostgreSQL] Hydration error for users:", err);
    }
  })();
}

export function listAllUsers(): PublicUser[] {
  ensureInitialUsers();
  return readAllUsers()
    .filter((u) => u.status !== "DELETED")
    .map(publicUser);
}

export function listAllUsersIncludingDeleted(): PublicUser[] {
  ensureInitialUsers();
  return readAllUsers().map(publicUser);
}

export function getUserById(id: string): StoredUser | null {
  ensureInitialUsers();
  return readAllUsers().find((u) => u.id === id) || null;
}

export function getPublicUserById(id: string): PublicUser | null {
  const user = getUserById(id);
  return user ? publicUser(user) : null;
}

export function getUserByEmail(email: string): StoredUser | null {
  ensureInitialUsers();
  const normalized = email.trim().toLowerCase();
  return readAllUsers().find((u) => u.email.trim().toLowerCase() === normalized) || null;
}

export function getUserByUsername(username: string): StoredUser | null {
  ensureInitialUsers();
  const normalized = username.trim().toLowerCase();
  return readAllUsers().find((u) => u.username.trim().toLowerCase() === normalized) || null;
}

export function findUserByEmailOrUsername(identifier: string): StoredUser | null {
  ensureInitialUsers();
  const clean = identifier.trim().toLowerCase();
  return (
    readAllUsers().find(
      (u) => u.email.trim().toLowerCase() === clean || u.username.trim().toLowerCase() === clean,
    ) || null
  );
}

export async function createUser(input: {
  name: string;
  email: string;
  username: string;
  password: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: Partial<UserPermissions>;
  limits?: Partial<UserLimits>;
}): Promise<PublicUser> {
  ensureInitialUsers();
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim().toLowerCase();

  if (!name || !email || !username || !input.password) {
    throw new ApiError("INVALID_INPUT", "Name, email, username and password are required.", 400);
  }
  if (!email.includes("@") || !email.includes(".")) {
    throw new ApiError("INVALID_EMAIL", "Please enter a valid email address.", 400);
  }
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
    throw new ApiError(
      "INVALID_USERNAME",
      "Username must be 3-30 characters long and contain only letters, numbers, underscores, dashes, or dots.",
      400,
    );
  }
  if (input.password.length < 6) {
    throw new ApiError("WEAK_PASSWORD", "Password must be at least 6 characters long.", 400);
  }

  const existingEmail = getUserByEmail(email);
  if (existingEmail && existingEmail.status !== "DELETED") {
    throw new ApiError("EMAIL_EXISTS", "An account with this email address already exists.", 409);
  }
  const existingUsername = getUserByUsername(username);
  if (existingUsername && existingUsername.status !== "DELETED") {
    throw new ApiError("USERNAME_EXISTS", "This username is already taken.", 409);
  }

  const users = readAllUsers();
  const now = new Date().toISOString();
  const newUser: StoredUser = {
    id: "user-" + randomUUID().slice(0, 10),
    name,
    email,
    username,
    passwordHash: hashPassword(input.password),
    role: input.role || "USER",
    status: input.status || "PENDING", // PENDING by default
    permissions: {
      ...DEFAULT_USER_PERMISSIONS,
      ...(input.permissions || {}),
    },
    limits: {
      ...DEFAULT_USER_LIMITS,
      ...(input.limits || {}),
    },
    createdAt: now,
    approvedAt: input.status === "ACTIVE" ? now : null,
    approvedBy: input.status === "ACTIVE" ? "ADMIN" : null,
  };

  users.push(newUser);
  writeAllUsers(users);
  return publicUser(newUser);
}

function mutateUser(userId: string, mutate: (user: StoredUser) => StoredUser): PublicUser {
  ensureInitialUsers();
  const users = readAllUsers();
  const idx = users.findIndex((u) => u.id === userId);
  const current = users[idx];
  if (idx < 0 || !current) {
    throw new ApiError("USER_NOT_FOUND", "User not found.", 404);
  }
  const next = mutate(current);
  users[idx] = next;
  writeAllUsers(users);
  return publicUser(next);
}

export function updateUserStatus(
  userId: string,
  status: UserStatus,
  approvedBy?: string,
): PublicUser {
  const now = new Date().toISOString();
  return mutateUser(userId, (current) => ({
    ...current,
    status,
    ...(status === "ACTIVE"
      ? {
          approvedAt: current.approvedAt || now,
          approvedBy: approvedBy || "ADMIN",
          suspendedAt: null,
        }
      : {}),
    ...(status === "SUSPENDED" ? { suspendedAt: now } : {}),
    ...(status === "DELETED" ? { deletedAt: now } : {}),
  }));
}

export function updateUserPermissions(
  userId: string,
  permissions: Partial<UserPermissions>,
): PublicUser {
  return mutateUser(userId, (current) => ({
    ...current,
    permissions: { ...current.permissions, ...permissions },
  }));
}

export function updateUserLimits(userId: string, limits: Partial<UserLimits>): PublicUser {
  return mutateUser(userId, (current) => ({
    ...current,
    limits: { ...current.limits, ...limits },
  }));
}

export function recordUserLogin(userId: string): void {
  ensureInitialUsers();
  const users = readAllUsers();
  const user = users.find((u) => u.id === userId);
  if (user) {
    user.lastLoginAt = new Date().toISOString();
    writeAllUsers(users);
  }
}
