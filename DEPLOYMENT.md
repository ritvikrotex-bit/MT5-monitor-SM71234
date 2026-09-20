# Deploying MT5 Monitor on the Windows RDP (next to Trade Intelligence)

The MT5 Manager API (`MT5Manager` + native Win64 DLL) only runs on Windows, so the host is the
same Windows RDP that runs Trade Intelligence. Both apps share one public IP and one Caddy.

```
Browser ─HTTPS─► Caddy :443  (already running for Trade Intel)
                   ├── brokerintel.itsrotex.com → Trade Intelligence (8000 / 8100 / 5173)
                   └── monitor.itsrotex.com     → MT5 Monitor web  127.0.0.1:3000  (Node: SSR + /api + alert poller)
                                                        └── MT5 connector 127.0.0.1:8765 (Python/FastAPI + MT5Manager) ──► broker MT5 Manager servers
```

No port clashes with Trade Intel. Only Caddy listens publicly; 3000 and 8765 are loopback-only.

This repo is **private and is the deployment source of truth**: it contains the `.env` files and
`data/` (operator logins, Wyn/Lotpip/Elefin brokers with Manager passwords encrypted by the committed
`encryption.key`, Telegram bot, monitored clients). **Never make it public** — anyone who can read
it can log in to the monitor and decrypt the broker credentials. Grant access only to people who
should have that, and use credentials dedicated to this app (a read-only Manager account and its own
Telegram bot). Alert history is not committed, so the RDP starts with a fresh alert history and
baselines every monitored client silently on its first poll.

**Stop the local copy first.** A local instance and the RDP poll the same clients from the same
`data/`, so both would send Telegram alerts. Run `stop.ps1` locally before starting the services here.

## 1. DNS (once)

Nameservers for `itsrotex.com` are `ns1/ns2.dns-parking.com`. In that DNS panel add:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `monitor` | `13.140.188.135` (same IP as `brokerintel`) | 300 |

Verify with `nslookup monitor.itsrotex.com` before configuring Caddy (Let's Encrypt needs it live).

## 2. Prerequisites on the RDP

Already present for Trade Intel: Python 3.12, Node LTS, Git, NSSM, Caddy. Verify with
`py -3.12 --version; node -v; nssm version; caddy version` (Node must be **≥ 20.6**).

## 3. First deploy (Admin PowerShell)

The repo is private, so the RDP needs read access to it. Create a **fine-grained personal access token**
(GitHub → Settings → Developer settings; repository: this repo only; permission: *Contents: Read-only*)
and use it as the password when git prompts (Git Credential Manager stores it, so later `git pull`s
— including `deploy\update.ps1` — work unattended). Use a token owned by a dedicated/machine account
rather than a personal one if colleagues join later.

```powershell
git clone https://github.com/ritvikrotex-bit/MT5-monitor-SM71234.git C:\apps\mt5-monitor
cd C:\apps\mt5-monitor
npm ci
npm run build                                   # → .output\server\index.mjs (Node server build)

cd mt5-connector
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt    # includes MT5Manager (+numpy)
cd ..

powershell -ExecutionPolicy Bypass -File deploy\install-services.ps1
```

`install-services.ps1` registers two auto-start NSSM services, `MT5MonitorConnector` and
`MT5MonitorWeb` (the web service depends on the connector), with rotating logs in `logs\`.

Configuration is already in the repo: `.env` (web) and `mt5-connector\.env`.
`MT5_CONNECTOR_SECRET` and `CONNECTOR_SECRET` must match. The connector always talks to the real MT5
Manager API (there is no mock mode). Templates: `.env.example`,
`mt5-connector\.env.example`.

## 4. Caddy

Append the block from [`deploy/Caddyfile.example`](deploy/Caddyfile.example) to the **existing**
Caddyfile (e.g. `C:\apps\trade-intel\Caddyfile`) and run
`caddy reload --config C:\apps\trade-intel\Caddyfile`. Do not start a second Caddy.

## 5. Verify

1. `curl http://127.0.0.1:8765/health` → `{"status":"ok","mode":"real"}`
2. `curl -I http://127.0.0.1:3000/` → `200`
3. `https://monitor.itsrotex.com` loads with a valid certificate; log in.
4. Brokers → **Test connection** → search a client → open positions (this is the first real MT5 test).
5. Add a monitored client: the first poll stores a baseline (no alert); then trigger a change →
   exactly one Telegram alert.
6. Reboot the RDP: both services and Caddy come back on their own.

Run **one** web instance only — the alert poller is a per-process singleton, so two instances would
send duplicate Telegram alerts.

## 6. Updating

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\mt5-monitor\deploy\update.ps1
```
(pull → `npm ci` → build → `pip install` → restart both services). There is no database migration:
state is JSON files in `data\`.

## Data notes

- **State lives in `data\`** (override with `DATA_DIR`). It is deliberately outside `.output\`, which
  every build wipes. `encryption.key` must stay with `brokers.json`, otherwise the stored Manager
  passwords cannot be decrypted.
- After the first deploy the **server owns `data\`** (broker status, monitored clients and
  Telegram settings are edited through the UI). If you also edit `data\` locally, `git pull` on the
  server first. `update.ps1` uses `--autostash` so runtime edits survive a pull.
- `data\notifications.json` (alert history + position snapshots) is git-ignored: it changes every
  few seconds and a fresh baseline on a new server avoids stale-snapshot alerts.
- `mt5-connector\bases\` is the MT5 Manager SDK's local cache (regenerated on connect, contains client
  rosters) and is git-ignored.
- Operators log in via `data\users.json` (`[{ "email", "password", "name" }]`, plain text, UTF-8 —
  a BOM is tolerated) plus the optional `MONITOR_AUTH_EMAIL/PASSWORD` in `.env`.

## Networking / security

- Expose only 80/443. RDP 3389 restricted to admin IPs. Never open 3000/8765.
- The RDP connects **out** to broker Manager servers (e.g. `185.28.255.63:443`, `185.28.255.65:443`). If
  Trade Intel already works from this box, the broker's IP whitelist is fine. If both apps use the
  **same Manager login**, confirm the broker allows concurrent Manager sessions.
- `MONITOR_POLL_INTERVAL_SECONDS` (default 5) sets how often each monitored client is polled against
  the broker's Manager API — don't go lower without checking broker limits.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Web service won't start | `logs\MT5MonitorWeb.err.log`; `Missing environment variable …` → fill `.env` |
| Login rejected for everyone | `[MT5 Auth] Could not read data/users.json` in the log → fix the JSON |
| `CONNECTOR_UNAVAILABLE` | MT5Manager not installed in `mt5-connector\.venv` (or 32-bit Python) |
| `Connect failed: Network error` | Broker unreachable / RDP IP not whitelisted; transient ones clear on retry |
| Alerts duplicated | More than one web instance running |
