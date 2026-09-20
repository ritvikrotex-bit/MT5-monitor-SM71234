-- MT5 Client Live Monitor - PostgreSQL Schema
-- Run automatically on startup when DATABASE_URL is configured, or manually via psql.

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'USER',
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by VARCHAR(64),
  last_login_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS brokers (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  server VARCHAR(255) NOT NULL,
  manager_login VARCHAR(128) NOT NULL,
  encrypted_password TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DISCONNECTED',
  status_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brokers_owner ON brokers(owner_user_id);

CREATE TABLE IF NOT EXISTS monitored_clients (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_id VARCHAR(64) NOT NULL,
  login BIGINT NOT NULL,
  client_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, broker_id, login)
);

CREATE INDEX IF NOT EXISTS idx_monitored_user ON monitored_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_monitored_broker_login ON monitored_clients(broker_id, login);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id VARCHAR(64) NOT NULL,
  actor_email VARCHAR(255) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(64),
  details JSONB,
  ip_address VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS telegram_config (
  id VARCHAR(32) PRIMARY KEY DEFAULT 'primary',
  bot_token TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  broker_id VARCHAR(64) NOT NULL,
  broker_name VARCHAR(255) NOT NULL,
  client_login BIGINT NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  position JSONB NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'sent'
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_snapshots (
  snapshot_key VARCHAR(255) PRIMARY KEY,
  positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
