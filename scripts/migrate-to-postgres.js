#!/usr/bin/env node
/**
 * MT5 Client Live Monitor - PostgreSQL Data Migration Utility
 *
 * Reads existing JSON stores in data/ and imports them directly into PostgreSQL.
 * Safe to run multiple times (idempotent upserts).
 *
 * Usage:
 *   node scripts/migrate-to-postgres.js
 * Or:
 *   DATABASE_URL=postgres://user:pass@localhost:5432/mt5_monitor node scripts/migrate-to-postgres.js
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const dataDir = process.env.DATA_DIR ? process.env.DATA_DIR : join(rootDir, "data");

// Load .env if not present in process.env
function loadEnv() {
  const envPath = join(rootDir, ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!dbUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is not set.");
  console.error("Please add DATABASE_URL to your .env file or pass it as an environment variable:");
  console.error(
    "  DATABASE_URL=postgres://user:password@127.0.0.1:5432/mt5_monitor node scripts/migrate-to-postgres.js",
  );
  process.exit(1);
}

console.log("🔗 Connecting to PostgreSQL at:", dbUrl.replace(/:[^:@]+@/, ":****@"));
const pool = new Pool({ connectionString: dbUrl });

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log("🛠️  Verifying and applying database schema...");
    const schemaPath = join(rootDir, "src", "server", "db", "schema.sql");
    if (!existsSync(schemaPath)) {
      throw new Error(`Schema file not found at: ${schemaPath}`);
    }
    const schemaSql = readFileSync(schemaPath, "utf-8");
    await client.query(schemaSql);
    console.log("✅ Schema tables and indexes are ready.\n");

    let totalUsers = 0;
    let totalBrokers = 0;
    let totalMonitored = 0;
    let totalAudit = 0;
    let totalTelegram = 0;
    let totalAlerts = 0;

    // 1. Migrate Users
    const usersFile = join(dataDir, "users.json");
    if (existsSync(usersFile)) {
      try {
        const raw = JSON.parse(readFileSync(usersFile, "utf-8"));
        const users = Array.isArray(raw) ? raw : raw.users || [];
        for (const u of users) {
          await client.query(
            `INSERT INTO users (
              id, name, email, username, password_hash, role, status,
              permissions, limits, created_at, approved_at, approved_by,
              last_login_at, suspended_at, deleted_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              password_hash = EXCLUDED.password_hash,
              role = EXCLUDED.role,
              status = EXCLUDED.status,
              permissions = EXCLUDED.permissions,
              limits = EXCLUDED.limits,
              approved_at = EXCLUDED.approved_at,
              approved_by = EXCLUDED.approved_by,
              last_login_at = EXCLUDED.last_login_at;`,
            [
              u.id,
              u.name || "User",
              u.email.toLowerCase(),
              u.username || u.email.split("@")[0],
              u.passwordHash,
              u.role || "USER",
              u.status || "ACTIVE",
              JSON.stringify(u.permissions || {}),
              JSON.stringify(u.limits || {}),
              u.createdAt ? new Date(u.createdAt) : new Date(),
              u.approvedAt ? new Date(u.approvedAt) : null,
              u.approvedBy || null,
              u.lastLoginAt ? new Date(u.lastLoginAt) : null,
              u.suspendedAt ? new Date(u.suspendedAt) : null,
              u.deletedAt ? new Date(u.deletedAt) : null,
            ],
          );
          totalUsers++;
        }
        console.log(`✅ Users migrated: ${totalUsers}`);
      } catch (err) {
        console.error("⚠️ Failed to parse/migrate users.json:", err.message);
      }
    }

    // 2. Migrate Brokers
    const brokersFile = join(dataDir, "brokers.json");
    if (existsSync(brokersFile)) {
      try {
        const raw = JSON.parse(readFileSync(brokersFile, "utf-8"));
        const brokers = Array.isArray(raw) ? raw : raw.brokers || [];
        for (const b of brokers) {
          await client.query(
            `INSERT INTO brokers (
              id, owner_user_id, name, server, manager_login, encrypted_password,
              status, status_message, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              server = EXCLUDED.server,
              manager_login = EXCLUDED.manager_login,
              encrypted_password = EXCLUDED.encrypted_password,
              status = EXCLUDED.status,
              status_message = EXCLUDED.status_message,
              updated_at = EXCLUDED.updated_at;`,
            [
              b.id,
              b.ownerUserId,
              b.name,
              b.server,
              String(b.managerLogin),
              b.encryptedPassword,
              b.status || "DISCONNECTED",
              b.statusMessage || "",
              b.createdAt ? new Date(b.createdAt) : new Date(),
              b.updatedAt ? new Date(b.updatedAt) : new Date(),
            ],
          );
          totalBrokers++;
        }
        console.log(`✅ Brokers migrated: ${totalBrokers}`);
      } catch (err) {
        console.error("⚠️ Failed to parse/migrate brokers.json:", err.message);
      }
    }

    // 3. Migrate Monitored Clients
    const monitoredFile = join(dataDir, "monitored.json");
    if (existsSync(monitoredFile)) {
      try {
        const raw = JSON.parse(readFileSync(monitoredFile, "utf-8"));
        const monitored = Array.isArray(raw) ? raw : raw.monitored || [];
        for (const m of monitored) {
          await client.query(
            `INSERT INTO monitored_clients (user_id, broker_id, login, client_name, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, broker_id, login) DO UPDATE SET
               client_name = EXCLUDED.client_name;`,
            [
              m.userId,
              m.brokerId,
              Number(m.login),
              m.clientName || null,
              m.createdAt ? new Date(m.createdAt) : new Date(),
            ],
          );
          totalMonitored++;
        }
        console.log(`✅ Monitored clients migrated: ${totalMonitored}`);
      } catch (err) {
        console.error("⚠️ Failed to parse/migrate monitored.json:", err.message);
      }
    }

    // 4. Migrate Audit Logs
    const auditFile = join(dataDir, "audit.json");
    if (existsSync(auditFile)) {
      try {
        const raw = JSON.parse(readFileSync(auditFile, "utf-8"));
        const logs = Array.isArray(raw) ? raw : raw.logs || [];
        for (const log of logs) {
          await client.query(
            `INSERT INTO audit_logs (id, timestamp, actor_id, actor_email, actor_role, action, target_type, target_id, details, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO NOTHING;`,
            [
              log.id,
              log.timestamp ? new Date(log.timestamp) : new Date(),
              log.actorId || "unknown",
              log.actorEmail || "",
              log.actorRole || "SYSTEM",
              log.action,
              log.targetType,
              log.targetId || null,
              JSON.stringify(log.details || {}),
              log.ipAddress || null,
            ],
          );
          totalAudit++;
        }
        console.log(`✅ Audit records migrated: ${totalAudit}`);
      } catch (err) {
        console.error("⚠️ Failed to parse/migrate audit.json:", err.message);
      }
    }

    // 5. Migrate Telegram Config
    const telegramFile = join(dataDir, "telegram.json");
    if (existsSync(telegramFile)) {
      try {
        const cfg = JSON.parse(readFileSync(telegramFile, "utf-8"));
        if (cfg.botToken && cfg.chatId) {
          await client.query(
            `INSERT INTO telegram_config (id, bot_token, chat_id, updated_at)
             VALUES ('primary', $1, $2, NOW())
             ON CONFLICT (id) DO UPDATE SET
               bot_token = EXCLUDED.bot_token,
               chat_id = EXCLUDED.chat_id,
               updated_at = NOW();`,
            [cfg.botToken, cfg.chatId],
          );
          totalTelegram = 1;
          console.log(`✅ Telegram configuration migrated.`);
        }
      } catch (err) {
        console.error("⚠️ Failed to parse/migrate telegram.json:", err.message);
      }
    }

    console.log("\n🎉 Database migration to PostgreSQL completed successfully!");
    console.log("Summary:");
    console.log(`  - Users: ${totalUsers}`);
    console.log(`  - Brokers: ${totalBrokers}`);
    console.log(`  - Monitored Accounts: ${totalMonitored}`);
    console.log(`  - Audit Logs: ${totalAudit}`);
    console.log(`  - Telegram Settings: ${totalTelegram ? "Configured" : "None"}`);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch((err) => {
  console.error("❌ Migration failed with error:", err);
  process.exit(1);
});
