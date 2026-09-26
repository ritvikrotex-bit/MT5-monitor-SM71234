# MT5 Trade Copier

Copies trades from one or more **master** accounts onto one or more
**destination** accounts, across different brokers and servers.

## The asymmetry that shapes everything

The two sides of a copy need very different access:

- A **master** is only ever *watched*. The MT5 **Manager API** already sees
  every account on a server from one connection, and `mt5-connector` exposes
  exactly that. So a master is identified by *broker + MT5 login*, needs no
  password of its own, needs no terminal, and nothing on this path is capable
  of placing an order on it.
- A **destination** is *traded on*. That needs trader access, which means a
  real MT5 terminal logged in with that account's trading password.

So only destinations get a terminal.

```
master: broker + login ──► mt5-connector (Manager API, read-only)
                                    │
                                    ▼
                          engine: reconcile ──► destination worker ──► orders
                                    ▲                (own terminal)
              config from the web app (PUT /v1/config)
```

Reading a master through its own terminal is implemented
(`TerminalMaster`) for the case where we hold an account's investor password
but no manager access to its server. It is not used yet.

## How the engine works

- **One worker process per destination.** The `MetaTrader5` package binds a
  process to a single terminal and a single account, so each destination gets
  its own portable terminal under `C:\mt5-terminals\<server>-<login>`
  (~227 MB) and its own subprocess. Passwords go over the worker's stdin,
  never on the command line.
- **It reconciles, it does not replay events.** Each cycle it reads the
  master's open positions, reads the positions it owns on the destination, and
  issues whatever orders close the gap. A restart, a dropped connection or a
  missed cycle therefore cannot duplicate or lose a trade.
- **Ownership is stamped on the trade.** Every copied position carries the
  link's magic number and a `c<master ticket>` comment, so the mapping survives
  losing the state file. Positions without that magic — manual trades, other
  links — are never touched.

## Configuration

The web app owns the configuration and pushes the whole desired state with
`PUT /v1/config`; this service stores only runtime state
(`state/copier-state.json`). Secrets stay in the web app's encrypted store.

A **link** is one master → one destination, with its own rules:

| Rule | What it does |
| --- | --- |
| `lotMode` | `FIXED`, `MULTIPLIER`, `BALANCE` or `EQUITY` |
| `lotValue` | the fixed lot, or the factor applied to the scaled volume |
| `maxLot` | hard cap per order |
| `minVolumeAction` | `SKIP` or `MIN` when the scaled lot is under the symbol minimum |
| `symbolMap` / `symbolSuffix` | explicit or suffix-based symbol translation |
| `allowSymbols` / `denySymbols` | base-name filters |
| `reverse` | copy in the opposite direction (stops are dropped) |
| `copySlTp` | mirror stop loss and take profit |
| `copyExisting` | copy positions already open when the link starts (off by default) |
| `maxOpenPositions` | cap on positions the link may hold |
| `maxDrawdownPct` | flatten and halt if destination equity falls this far |
| `dryRun` | log every decision, send nothing |

Volumes always round **down** to the symbol's lot step, so a rounding error can
never increase exposure.

## Safety

- New links start **stopped and in dry run**.
- A link **halts** — and stays halted until a human arms it — if the
  destination cannot trade, if the destination is netting rather than hedging
  (copies of separate master trades would merge and closes would hit the wrong
  one), or if the drawdown guard fires.
- **Arming resumes from now.** Whatever the master holds at that moment is left
  alone, so re-arming after a drawdown halt does not pile back into the trades
  that caused it. Positions the link still owns stay managed.
- **An unreadable master is not an empty master.** If the connector is down the
  cycle fails and is reported; copies are never closed on the strength of a
  failed read.
- An order that fails for a non-transient reason is retried on a backoff, not
  on every cycle.
- A symbol that cannot be resolved is **skipped and reported**, never guessed.

## Endpoints

All except `/health` require the `X-Copier-Secret` header.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness |
| PUT | `/v1/config` | replace destinations and links |
| GET | `/v1/status` | per-link state, last cycle, worker health |
| GET | `/v1/events` | recent copy decisions |
| POST | `/v1/accounts/{id}/probe` | log in to a destination and report it, no trading |
| POST | `/v1/links/{id}/arm` | clear a halt and resume from now |
| POST | `/v1/links/{id}/flatten` | close every destination position the link owns |

## Running

```powershell
cd mt5-copier
python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env   # then fill in COPIER_SECRET and CONNECTOR_SECRET
.\.venv\Scripts\python -m uvicorn copier.main:app --host 127.0.0.1 --port 8766
```

Requires Windows x64, a MetaTrader 5 terminal installed at
`C:\Program Files\MetaTrader 5` (cloned per destination account), and a running
`mt5-connector` for master accounts.

## Tests

```powershell
python -m pytest tests -q
```

64 tests, no broker connection needed. They cover symbol translation and lot
rounding, reading a master through a simulated connector, and the
reconciliation failure modes that cost money: copying a trade twice, missing a
close, re-copying everything after a restart, closing copies because the master
became unreadable, and touching positions that belong to somebody else.
