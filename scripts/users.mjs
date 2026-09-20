#!/usr/bin/env node
// Manage operator/admin accounts in data/users.json (or $DATA_DIR/users.json) from the command line.
// Passwords are stored as scrypt hashes ("salt:key"), the same format the web app verifies.
//
//   node scripts/users.mjs list
//   node scripts/users.mjs add <email> <username> <"Full Name"> <ADMIN|USER> <password> [fixed-id]
//   node scripts/users.mjs set-password <email-or-username> <new-password>
//   node scripts/users.mjs set-role <email-or-username> <ADMIN|USER>
//   node scripts/users.mjs set-status <email-or-username> <ACTIVE|SUSPENDED|PENDING>
//
// The web service caches users in memory: restart it after changing anything
// (Windows: nssm restart MT5MonitorWeb).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR?.trim()
  ? resolve(process.env.DATA_DIR.trim())
  : join(root, "data");
const file = join(dataDir, "users.json");

const USER_PERMISSIONS = {
  canLogin: true,
  canAddBroker: true,
  canConnectBroker: true,
  canMonitorClients: true,
  canUseTelegram: true,
  canUseEmail: true,
  canUsePush: true,
};
const USER_LIMITS = { maxBrokers: 5, maxMonitoredClients: 25 };
// Admins oversee the platform; they do not connect brokers or monitor clients themselves.
const ADMIN_PERMISSIONS = {
  ...USER_PERMISSIONS,
  canAddBroker: false,
  canConnectBroker: false,
  canMonitorClients: false,
};
const ADMIN_LIMITS = { maxBrokers: 0, maxMonitoredClients: 0 };

const hash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};

function load() {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  return Array.isArray(parsed) ? parsed : (parsed.users ?? []);
}
const save = (users) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(users, null, 2) + "\n", "utf8");
};
const find = (users, id) => {
  const key = String(id).trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === key || u.username.toLowerCase() === key);
};
const die = (message) => {
  console.error(message);
  process.exit(1);
};

const [cmd, ...args] = process.argv.slice(2);
const users = load();

if (cmd === "list") {
  for (const u of users)
    console.log(
      `${u.role.padEnd(5)} ${u.status.padEnd(9)} ${u.email}  (username: ${u.username}, id: ${u.id})`,
    );
} else if (cmd === "add") {
  const [email, username, name, role, password, fixedId] = args;
  if (!email || !username || !name || !password || !["ADMIN", "USER"].includes(role))
    die('usage: add <email> <username> <"Full Name"> <ADMIN|USER> <password>');
  if (password.length < 8) die("password must be at least 8 characters");
  if (find(users, email) || find(users, username))
    die("a user with that email or username already exists");
  const now = new Date().toISOString();
  const admin = role === "ADMIN";
  users.push({
    id: fixedId || (admin ? "admin-" : "user-") + randomUUID().slice(0, 8),
    name,
    email: email.toLowerCase(),
    username: username.toLowerCase(),
    passwordHash: hash(password),
    role,
    status: "ACTIVE",
    permissions: admin ? ADMIN_PERMISSIONS : USER_PERMISSIONS,
    limits: admin ? ADMIN_LIMITS : USER_LIMITS,
    createdAt: now,
    approvedAt: now,
    approvedBy: "CLI",
  });
  save(users);
  console.log(`added ${role} ${email}`);
} else if (cmd === "set-password") {
  const [id, password] = args;
  const u = id && find(users, id);
  if (!u || !password) die("usage: set-password <email-or-username> <new-password>");
  if (password.length < 8) die("password must be at least 8 characters");
  u.passwordHash = hash(password);
  save(users);
  console.log(`password updated for ${u.email}`);
} else if (cmd === "set-role") {
  const [id, role] = args;
  const u = id && find(users, id);
  if (!u || !["ADMIN", "USER"].includes(role))
    die("usage: set-role <email-or-username> <ADMIN|USER>");
  u.role = role;
  u.permissions = role === "ADMIN" ? ADMIN_PERMISSIONS : USER_PERMISSIONS;
  u.limits = role === "ADMIN" ? ADMIN_LIMITS : USER_LIMITS;
  save(users);
  console.log(`${u.email} is now ${role}`);
} else if (cmd === "set-status") {
  const [id, status] = args;
  const u = id && find(users, id);
  if (!u || !["ACTIVE", "SUSPENDED", "PENDING"].includes(status))
    die("usage: set-status <email-or-username> <ACTIVE|SUSPENDED|PENDING>");
  u.status = status;
  save(users);
  console.log(`${u.email} is now ${status}`);
} else {
  die("commands: list | add | set-password | set-role | set-status  (see the header of this file)");
}
