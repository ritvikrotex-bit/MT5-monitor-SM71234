# MT5 Trade Copier

Copies trades from one or more **master** accounts onto one or more
**destination** accounts, across different brokers and servers.

This is a separate service from `mt5-connector`. The connector uses the MT5
**Manager** API, which is read-only and only works on a server we hold manager
credentials for. Placing orders needs *trader* access, which means a real MT5
terminal logged in to the destination account — that is what this service runs.

## How it works

```
master account ─┐
                ├─ worker (own terminal) ─┐
master account ─┘                         │
                                          ├─ engine: reconcile ─→ destination worker ─→ orders
                        config from the web app (PUT /v1/config)
```

* **One worker process per account.** The `MetaTrader5` package binds a process
  to a single terminal and a single account, so each account gets its own
  portable terminal under `C:\mt5-terminals\<server>-<login>` (~227 MB each)
  and its own subprocess. Passwords go over the worker's stdin, never on the
  command line.
* **The engine reconciles, it does not replay events.** Each cycle it reads the
  master's open positions, reads the positions it owns on the destination, and
  issues whatever orders close the gap. A restart, a dropped connection or a
  missed cycle therefore cannot duplicate or lose a trade.
* **Ownership is stamped on the trade.** Every copied position carries the
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

* New links start in **dry run**.
* A link **halts** — and stays halted until a human arms it — if the
  destination cannot trade, if the destination is netting while the master is
  hedging (closes would hit the wrong trade), or if the drawdown guard fires.
* **Arming resumes from now.** Whatever the master holds at that moment is left
  alone, so re-arming after a drawdown halt does not pile back into the trades
  that caused it. Positions the link still owns stay managed.
* An order that fails for a non-transient reason is retried on a backoff, not
  on every cycle.
* A symbol that cannot be resolved is **skipped and reported**, never guessed.

## Endpoints

All except `/health` require the `X-Copier-Secret` header.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness |
| PUT | `/v1/config` | replace accounts and links |
| GET | `/v1/status` | per-link state, last cycle, worker health |
| GET | `/v1/events` | recent copy decisions |
| POST | `/v1/accounts/{id}/probe` | log in and report the account, no trading |
| POST | `/v1/links/{id}/arm` | clear a halt and resume from now |
| POST | `/v1/links/{id}/flatten` | close every destination position the link owns |

## Running

```powershell
cd mt5-copier
python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt
$env:COPIER_SECRET = "<same value the web app sends>"
.\.venv\Scripts\python -m uvicorn copier.main:app --host 127.0.0.1 --port 8766
```

Requires Windows x64 and a MetaTrader 5 terminal installed at
`C:\Program Files\MetaTrader 5`, which is cloned per account.

## Tests

```powershell
$env:COPIER_SECRET = "test"; python -m pytest tests -q
```

The engine tests run against a simulated pair of accounts and cover the failure
modes that cost money: copying a trade twice, missing a close, re-copying
everything after a restart, and touching positions that belong to somebody else.
They need no broker connection.
