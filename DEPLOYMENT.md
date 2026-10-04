# Deploying MT5 Monitor on the Windows RDP (next to Trade Intelligence)

The MT5 Manager API (`MT5Manager` + native Win64 DLL) only runs on Windows, so the host is the
same Windows RDP that runs Trade Intelligence. Both apps share one public IP and one Caddy.

```
Browser ─HTTPS─► Caddy :443  (already running for Trade Intel)
                   ├── brokerintel.itsrotex.com → Trade Intelligence (8000 / 8100 / 5173)
                   └── mt5-monitor.itsrotex.com     → MT5 Monitor web  127.0.0.1:3000  (Node: SSR + /api + alert poller)
                                                        └── MT5 connector 127.0.0.1:8765 (Python/FastAPI + MT5Manager) ──► broker MT5 Manager servers
```

No port clashes with Trade Intel. Only Caddy listens publicly; 3000 and 8765 are loopback-only.

This repo is **private and is the deployment source of truth**: it contains the `.env` files and
`data/` (user accounts with hashed passwords, Wyn/Lotpip/Elefin brokers with Manager passwords encrypted by the committed
`encryption.key`, each user's Telegram bot token (encrypted), monitored clients). **Never make it public** — anyone who can read
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
| A | `mt5-monitor` | `13.140.188.135` (same IP as `brokerintel`) | 300 |

Verify with `nslookup mt5-monitor.itsrotex.com` before configuring Caddy (Let's Encrypt needs it live).

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

1. `Invoke-RestMethod http://127.0.0.1:8765/health` → `status ok`, `mode real`
   (in Windows PowerShell `curl` is an alias that rejects `-I`; use these cmdlets or `curl.exe`)
2. `(Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing).StatusCode` → `200`
   and `nssm status MT5MonitorConnector; nssm status MT5MonitorWeb` → both `SERVICE_RUNNING`
   Live polling: `Get-Content logs\MT5MonitorConnector.out.log -Tail 20` shows
   `POST /v1/clients/positions … 200 OK` (request lines are in `out.log`, start-up lines in `err.log`);
   `503` means that broker's Manager server is refusing this IP.
3. `https://mt5-monitor.itsrotex.com` loads with a valid certificate; log in.
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
(stop services → back up `data\` → `git reset --hard origin/main` → restore `data\` → `npm ci` → build → `pip install` → start services). Your server data is preserved. Add `-ResetData` once to replace `data\` with the repository's seed data instead (alert history and audit trail are cleared; the old data is backed up under `logs\data-backup\<timestamp>`). There is no database migration:
state is JSON files in `data\` (PostgreSQL is optional, see below). The running service keeps users in
memory, so any change made with `npm run users` needs `nssm restart MT5MonitorWeb`.

**Upgrading from an earlier build:** run `update.ps1` (default mode keeps the server's own `data\`). Accounts,
brokers and the watchlist are untouched. If `data\telegram.json` is still in the old *shared* format
(`{ botToken, chatId }`), it is converted automatically on the first start: the bot is assigned to the one user
who has monitored clients and its token is encrypted (the log shows `Migrated the old shared Telegram bot to
user …`). If several users have monitored clients it cannot tell whose bot it is, so each user simply sets their
own under *Settings → Telegram*. Existing alert history and position snapshots (`data\notifications.json`, not in
git) are kept, so nothing is re-baselined and no false alerts are sent.

## Accounts, admin and approvals

- **Roles.** `ADMIN` oversees the platform (users, approvals, all brokers/monitored clients, audit trail,
  each user's Telegram status) but does not connect brokers or monitor clients itself. `USER` accounts add their
  own brokers and monitor their own clients; users never see each other's data.
- **Sign in.** `https://mt5-monitor.itsrotex.com` has a *Client Login* and an *Admin Login* tab. Sign-in works with
  email or username. New people can **sign up**, but stay `PENDING` (cannot log in) until an admin approves
  them under *Pending Approvals*. Admins can suspend or delete users (effective immediately, even for
  logged-in sessions), set per-user limits (default 5 brokers / 25 monitored clients) and toggle permissions.
- **Audit trail.** Logins, failed logins, signups, approvals, limit/permission changes, broker and monitor
  changes and Telegram changes are recorded (`data\audit.json`, latest 5,000 entries, not in git).
- **Telegram is per user.** Each user opens *Settings → Telegram* and pastes **their own** bot token (from
  @BotFather) and chat ID. The details are verified with a real test message before they are saved, and the
  token is stored encrypted in `data\telegram.json` (never returned by the API). Alerts for a user's monitored
  clients go **only** to that user's chat: there is no shared bot and no fallback, so one user's trades are
  never sent to another user's group. A user with no Telegram set up still gets in-app alerts. An admin can
  switch Telegram off for an account (permission *Telegram*). Clients: each account/server is watched by one
  user at a time.
- **There is no default admin.** Accounts live in `data\users.json` as scrypt hashes. Manage them on the
  server, then `nssm restart MT5MonitorWeb`:
  ```powershell
  cd C:\apps\mt5-monitor
  npm run users -- list
  npm run users -- add someone@example.com someone "Full Name" USER "StrongPassword"
  npm run users -- set-password sankalp "NewStrongPassword"
  npm run users -- set-role someone ADMIN          # or USER
  npm run users -- set-status someone SUSPENDED    # or ACTIVE
  ```
  On a brand-new install with no admin, set `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` in `.env` for the
  first start (see `.env.example`).
- **Change the initial passwords after the first login**: they are known to everyone who has repo access.

## Trade copier (optional)

The copier places real orders, so it is **off unless you install it**. Without
`mt5-copier\.venv` and `mt5-copier\.env` the service is never created, the
Copier page reports the service as unreachable, and nothing is copied.

How the two sides differ matters for what you have to supply:

* A **master** is only watched. It is an account on a broker you have already
  added to MT5 Monitor, read through the Manager connection the connector
  already holds. You do **not** need, and never store, that account's own
  password.
* A **destination** is traded on. That needs its MT5 **trading** password (an
  investor password cannot place orders) and gets its own portable MT5
  terminal, about 230 MB, under `C:\mt5-terminals`.

Install it (Admin PowerShell, in `C:\apps\mt5-monitor`):

```powershell
python -m venv mt5-copier\.venv
mt5-copier\.venv\Scripts\python.exe -m pip install -r mt5-copier\requirements.txt
Copy-Item mt5-copier\.env.example mt5-copier\.env
# then edit mt5-copier\.env:
#   COPIER_SECRET    = a fresh 64-hex value
#   CONNECTOR_SECRET = the same value as MT5_CONNECTOR_SECRET in .env
# and add to the web app's .env:
#   MT5_COPIER_SECRET = the same value as COPIER_SECRET above
powershell -ExecutionPolicy Bypass -File deploy\install-copier-task.ps1
Invoke-RestMethod http://127.0.0.1:8766/health
```

MetaTrader 5 must be installed on the RDP at `C:\Program Files\MetaTrader 5`;
each destination terminal is cloned from it.

**The copier is not a Windows service.** An MT5 terminal cannot start in a
service's session (session 0): the copier there gets `(-10005, 'IPC timeout')`
for every account. `install-copier-task.ps1` removes any old `MT5MonitorCopier`
service and runs the copier as a scheduled task in the logged-in RDP session
instead. Run it while logged in as the account that keeps that session, then:

* **Disconnect** by closing the RDP window. Never **Sign out**: that ends the
  session, and the copier with it.
* After a reboot the copier starts when that account logs in. For an unattended
  recovery, enable automatic logon (Sysinternals Autologon).

**An account that will not connect.** The account on the Copier page says why:
when its terminal does not answer, the error quotes the terminal's own journal
and any window it is showing. For the full picture run
`deploy\copier-doctor.ps1` (how the copier runs, each account's last error, the
MT5 versions, terminal processes and their sessions, journals, the copier log).
`deploy\copier-doctor.ps1 -Repair` gives every account a fresh terminal folder,
keeping its server list; the old folder is kept as `<name>.reset-<time>`.

Then, in the app: an administrator turns on **Trade Copier** for the user
(Admin → Users → permissions). It is off for everyone by default, including
admins. The user adds a destination account, creates a link picking the
master's broker and MT5 login, and starts it. **New links start stopped and in
dry run** — watch the activity log agree with what the master is doing before
switching one live.

### Telegram alerts for copied trades

Nothing extra to configure. Every copy, close, skip, halt and order error for a
link goes to the Telegram bot its owner already set up under Settings, showing
both sides of the trade — the master account and ticket, and the destination
account, ticket and fill. A user with no bot configured simply gets nothing.

### Running 24/7

The `MT5MonitorCopier` scheduled task starts at logon and runs
`deploy\run-copier.cmd`, which restarts the copier 5 seconds after any exit and
logs to `logs\MT5MonitorCopier.*.log`. `update.ps1` stops and restarts it with
the services. Three things make an unattended restart safe:

* The copier holds no configuration of its own. The web app pushes it at boot
  and re-pushes every 60 seconds, so a copier that restarts alone picks its
  links back up without anyone touching the UI.
* Which destination position mirrors which master one is on disk, and is
  recoverable from the magic number and comment on the positions themselves, so
  a restart cannot duplicate or orphan a copy.
* Each destination terminal is supervised. Killing `terminal64.exe` outright
  was tested: the worker noticed, relaunched it, re-attached to the account and
  carried on within seconds.

Alert delivery survives both restarts too — the cursor is persisted, so neither
a web app restart nor a copier restart replays old trades into anyone's phone.

Safety worth knowing before you arm anything:

* A link halts, and stays halted until a human arms it, if the destination
  cannot trade, if the destination is netting rather than hedging, or if its
  equity falls past the drawdown limit you set.
* Arming resumes **from now**: whatever the master is holding at that moment is
  left alone, so re-arming after a drawdown halt does not pile straight back in.
* If the connector is down the master is unreadable, which is not the same as
  the master having no positions — copies are never closed because of a failed
  read.
* "Close all" on a link closes only the positions that link opened. Manual
  trades and other links are never touched.

## PostgreSQL (optional; not needed for a small team)

Leave `DATABASE_URL` unset and everything runs from the JSON files in `data\`. If it is set, the app mirrors
users, brokers, monitored clients and the audit log into PostgreSQL (schema in
`src/server/db/schema.sql`, applied automatically) and loads them from it at start-up. Alerts and position
snapshots stay in JSON. To import existing JSON data: `npm run db:migrate`. Only enable it if you actually run
PostgreSQL on the RDP; an unreachable `DATABASE_URL` is logged and ignored, it does not stop the app.

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
- Accounts are in `data\users.json` (scrypt-hashed; change passwords with `npm run users`, never by hand).
  `data\audit.json` is runtime-only and git-ignored.

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
| Nobody can log in / no admin | `[MT5 Auth] No administrator account exists` in the log → `npm run users -- add … ADMIN …` |
| A user says "awaiting approval" | Admin → *Pending Approvals* → approve |
| `CONNECTOR_UNAVAILABLE` | MT5Manager not installed in `mt5-connector\.venv` (or 32-bit Python) |
| `Connect failed: Network error` | Broker unreachable / RDP IP not whitelisted; transient ones clear on retry |
| Alerts duplicated | More than one web instance running |
