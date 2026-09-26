# MT5 Client Live Monitor

Read-only monitoring for MetaTrader 5 client accounts. It can look up client accounts and open
positions and alert on changes, but exposes no MT5 trade, order, dealer, or account-modification
operation.

```
React / TanStack Start (SSR + /api + alert poller, :3000)
        └── Python MT5 connector (FastAPI + MT5Manager, :8765) ──► MT5 Manager server
```

## Run locally

Requirements: Node ≥ 20.6 and Python 3.10–3.13 on **Windows x64** (the MT5 Manager API is Windows-only).

```powershell
npm ci

cd mt5-connector
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..

npm run dev:all          # connector + Vite dev server (hot reload) → http://localhost:3000
npm run build; npm start # or: production build, both services
```

The app talks to **real** brokers; there is no mock/demo mode. It uses whatever is in `data/`, so a
local instance and the RDP would both poll the same clients and send **duplicate Telegram alerts**.
Run it in one place at a time (`stop.ps1` stops the local services).

Scripts: `npm run typecheck`, `npm run lint`, `npm run format`. Connector tests:
`cd mt5-connector; .\.venv\Scripts\python.exe -m pytest tests`.

## Accounts and admin

Multi-user with roles: `USER` (own brokers and monitored clients) and `ADMIN` (oversight console at `/admin`:
user directory, sign-up approvals, per-user limits and permissions, broker/monitored oversight, audit trail,
per-user Telegram status). Sign-up requires admin approval. Accounts are stored hashed in `data/users.json`;
manage them with `npm run users -- list | add | set-password | set-role | set-status`. There is no default
admin account. Details in [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

See [`.env.example`](.env.example) and [`mt5-connector/.env.example`](mt5-connector/.env.example).
Persistent state (brokers, users, monitored clients, Telegram, `encryption.key`) is stored in `data/`
(override with `DATA_DIR`). Alert history (`data/notifications.json`) is not committed, so every new
server starts with a fresh alert history.

## Telegram alerts

Telegram is **per user**: each user pastes their own bot token and chat id in the web UI (Settings → Telegram),
and alerts for that user's monitored clients go only to that chat (token stored encrypted, verified with a test
message before saving). The first poll of each monitored account stores a baseline and sends nothing;
later polls detect new/closed positions, volume changes and SL/TP changes. A failed or unreachable
MT5 read is never treated as "position closed". The poller runs inside the web process every
`MONITOR_POLL_INTERVAL_SECONDS` (default 5).

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) (Windows RDP, NSSM services, shared Caddy, subdomain).

## Security

**This repository must stay private.** It intentionally commits `.env` files and `data/` (operator
logins, broker Manager credentials encrypted with the committed `encryption.key`, Telegram bot token)
so a `git clone` reproduces the working system. Anyone with read access to the repo can therefore
operate the monitor and decrypt the broker credentials — grant access only to people who should have
that. Use credentials dedicated to this app (a read-only Manager account, its own Telegram bot) and
rotate them if the access list changes.
