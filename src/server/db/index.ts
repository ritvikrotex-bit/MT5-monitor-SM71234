import pg from "pg";
import schemaSql from "./schema.sql?raw";

const { Pool } = pg;

declare global {
  var __mt5_pg_pool__: pg.Pool | undefined;
  var __mt5_db_initialized__: boolean | undefined;
}

export function getDatabaseUrl(): string | null {
  const url = process.env["DATABASE_URL"] || process.env["POSTGRES_URL"];
  if (url && url.trim().length > 0) {
    return url.trim();
  }
  return null;
}

export function isPostgresConfigured(): boolean {
  return getDatabaseUrl() !== null;
}

export function getDbPool(): pg.Pool | null {
  const dbUrl = getDatabaseUrl();
  if (!dbUrl) return null;

  if (globalThis.__mt5_pg_pool__) {
    return globalThis.__mt5_pg_pool__;
  }

  const pool = new Pool({
    connectionString: dbUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[Database] Unexpected idle PostgreSQL client error:", err);
  });

  globalThis.__mt5_pg_pool__ = pool;
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const pool = getDbPool();
  if (!pool) {
    throw new Error("PostgreSQL is not configured. DATABASE_URL is required.");
  }
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function initDatabaseSchema(): Promise<boolean> {
  if (!isPostgresConfigured()) {
    return false;
  }

  if (globalThis.__mt5_db_initialized__) {
    return true;
  }

  const pool = getDbPool();
  if (!pool) return false;

  try {
    const sql = schemaSql;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log("[Database] Connected to PostgreSQL. Schema verified successfully.");
      globalThis.__mt5_db_initialized__ = true;
      return true;
    } catch (sqlErr) {
      await client.query("ROLLBACK");
      console.error("[Database] Failed to execute PostgreSQL schema initialization:", sqlErr);
      return false;
    } finally {
      client.release();
    }
  } catch (connErr) {
    console.error("[Database] Could not connect to PostgreSQL database:", connErr);
    return false;
  }
}
