# hlbot Platform (Phase 1)

![Coverage](badges/coverage.svg) [![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-brightgreen.svg?style=flat-square)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Phase 1 refactors the legacy single-process tracker into a four-service monorepo with shared Postgres, NATS JetStream, JSON-schema-backed contracts, and an end-to-end fake flow (Candidates → Scores → Fills → Signals → Outcomes).

```
services/
  hl-scout   TypeScript  — address ingest + seeding + candidate emitter
  hl-stream  TypeScript  — watcher/WS + real-time fill publisher + dashboard
  hl-sage    Python      — scoring + ranks API
  hl-decide  Python      — decision engine + tickets/outcomes
contracts/              — jsonschema + generated zod & pydantic bindings
docker/postgres-init    — SQL auto-run when Postgres initializes a fresh volume
```

## Quick Start

```bash
npm install
cp .env.example .env          # tweak OWNER_TOKEN etc if needed
docker compose up --build
```
The Postgres container runs every SQL file under `docker/postgres-init/` the first time it creates its data directory, so the schema loads automatically. Docker Compose has healthchecks for every container, so `docker compose ps` will show `(healthy)` once each service responds on `/healthz`.

Health endpoints (`http://127.0.0.1:{port}/healthz`):

| Service   | Host Port | Role |
|-----------|-----------|------|
| hl-scout  | 4101      | Address admin + candidate publisher |
| hl-stream | 4102      | Watchlist WS + fake fill publisher |
| hl-sage   | 4103      | Candidate consumer → equal-weight scoring |
| hl-decide | 4104      | Scores + fills → signals → tickets/outcomes |
| Postgres  | 5432      | Persistent storage (`hlbot` DB) |
| NATS      | 4222      | Bus (`a/b/c/d.*.v1`) |

### API docs / Swagger
| Service | UI URL | Notes |
|---------|--------|-------|
| hl-scout | http://localhost:4101/docs | Swagger UI for address + admin endpoints (set `x-owner-key`). |
| hl-stream | http://localhost:4102/docs | Swagger UI documenting watchlist + `/ws`. |
| hl-sage | http://localhost:4103/docs | FastAPI interactive docs (candidates/scores). |
| hl-decide | http://localhost:4104/docs | FastAPI interactive docs (signals/outcomes). |
| Ops dashboard | http://localhost:4102/dashboard | Live TradingView chart, address stats, fills, and decision feed. |

### End-to-end smoke
```bash
npm run e2e-smoke          # Seeds → waits for d.outcomes.v1 → prints trace
```

### Local dev

- `npm run dev:scout` / `npm run dev:stream` for the TS services.
- Python services can be run with `uvicorn services.hl-sage.app.main:app --reload --port 4103` etc (ensure NATS + Postgres running).

## Message Contracts
Schemas live under `contracts/jsonschema`. `scripts/generate-contracts.mjs` emits:

| Topic            | Schema (zod/pydantic)  | Publisher → Consumer |
|------------------|------------------------|----------------------|
| `a.candidates.v1`| `CandidateEvent`       | hl-scout → hl-sage   |
| `b.scores.v1`    | `ScoreEvent`           | hl-sage → hl-decide  |
| `c.fills.v1`     | `FillEvent`            | hl-stream → hl-decide |
| `d.signals.v1`   | `SignalEvent`          | hl-decide → (persist) |
| `d.outcomes.v1`  | `OutcomeEvent`         | hl-decide → (persist) |

Run `npm run contracts:generate` to refresh bindings (automatically wired as `prebuild`).

## Database

When the Postgres container receives a fresh data directory it automatically executes every `.sql` file in `docker/postgres-init/` in alphabetical order. These scripts create all shared tables (`addresses`, `hl_events`, `hl_current_positions`, `marks_1m`, `tickets`, `ticket_outcomes`, `hl_leaderboard_entries`, `sage_tracked_addresses`, `decide_scores`, `decide_fills`, …) and performance indexes, so you do **not** need to run any manual migrations. To reset the schema, run `docker compose down -v` and bring the stack back up—Postgres will reapply the full schema during initialization.

**Note**: Init scripts only run on first container creation. To apply new schema changes to an existing database:

```bash
# Apply a specific migration
docker compose exec postgres psql -U hlbot -d hlbot -f /docker-entrypoint-initdb.d/008_add_hl_events_indexes.sql

# Or reset everything (drops all data)
docker compose down -v && docker compose up --build
```

## Environment

Key variables (see `.env.example`):

| Var              | Default                          | Description |
|------------------|----------------------------------|-------------|
| `OWNER_TOKEN`    | `dev-owner`                      | Shared HTTP auth (header `x-owner-key`) |
| `NATS_URL`       | `nats://nats:4222`               | NATS connection string |
| `DATABASE_URL`   | `postgresql://hlbot:...@postgres`| Postgres DSN |
| `SCOUT_SEEDS`    | 3 demo 0x addresses              | Initial candidates emitted on boot |
| `SCOUT_URL`      | `http://hl-scout:8080`           | Used by hl-stream to refresh watchlist |
| `LEADERBOARD_API_URL` | `https://...` | Leaderboard API URL |
| `LEADERBOARD_TOP_N` | `1000` | Number of leaderboard entries fetched per period |
| `LEADERBOARD_SELECT_COUNT` | `12` | Auto-tracked addresses pushed to hl-stream/hl-sage |
| `LEADERBOARD_PERIODS` | `30` | Leaderboard period (days) to track |
| `LEADERBOARD_REFRESH_MS` | `86400000` | Crawl cadence (ms) |
| `LEADERBOARD_SORT` | `3` | Sort order: 0=WinRate, 1=AccountValue, 3=PnL, 4=Trades, 5=ProfitableTrades, 6=LastOp, 7=AvgHold, 8=Positions |
| `LEADERBOARD_ENRICH_COUNT` | `12` | How many ranked wallets to enrich with stats + curves per refresh |
| `LEADERBOARD_STATS_CONCURRENCY` | `4` | Parallel leaderboard detail requests |
| `LEADERBOARD_SERIES_CONCURRENCY` | `2` | Parallel Hyperliquid `portfolio` requests |
| `*_PORT`         | `410{1-4}`                       | Host-forwarded HTTP ports |

Compose keeps everything on an isolated bridge network and only binds owner HTTP ports to `127.0.0.1`.

### Clean rebuild / restart

When you want to wipe everything and start from scratch:

```bash
docker compose down -v          # stop services and drop volumes
npm install                     # ensure deps are up to date
npm run build                   # compile TS services
docker compose up --build -d    # rebuild and restart the stack
```

Once `docker compose ps` shows each service as `(healthy)`, the platform is ready. If you need the demo addresses back after nuking Postgres, call `POST /admin/seed` on hl-scout with your owner token.

## Tooling

| Script                 | Purpose |
|------------------------|---------|
| `npm run build`        | TypeScript project references + `tsc-alias` |
| `npm run dev:scout`    | Watch mode for hl-scout |
| `npm run dev:stream`   | Watch mode for hl-stream |
| `npm run contracts:generate` | Rebuild zod/pydantic bindings |
| `npm run e2e-smoke`    | Seed + wait for Candidate→Outcome flow |
| `npm run docker:rebuild` | Full rebuild: stop containers, build fresh images (no cache), start |
| `npm run docker:up`    | Start all Docker containers |
| `npm run docker:down`  | Stop all Docker containers |
| `npm run docker:logs`  | Follow container logs |
| `npm run docker:ps`    | Show container status |

### Docker Commands

For quick container management without typing full `docker compose` commands:

```bash
npm run docker:rebuild   # Tear down, clean build, restart with latest code
npm run docker:up        # Start containers
npm run docker:down      # Stop containers
npm run docker:logs      # Tail all logs
npm run docker:ps        # Check status
```

The `docker:rebuild` command is useful when you want to ensure all containers are rebuilt from scratch with your latest code changes. It runs:
```bash
docker compose down && docker compose build --no-cache && docker compose up -d
```

## Service Notes

### hl-scout (TS)
- Express API for addresses (`GET/POST/DELETE /addresses`).
- `POST /admin/seed` & `/admin/backfill/:address` require `x-owner-key`.
- Crawls the Hyperliquid leaderboard on a schedule (30-day period, top-N), scoring entries by win rate, PnL efficiency, and pnlList consistency, then publishes `a.candidates.v1` with weights/metadata.
- On startup, automatically seeds the leaderboard if no entries exist.
- Reuses Hyperliquid info/backfill helpers to warm Postgres (`hl_events`).  
- Swagger UI at http://localhost:4101/docs.

### hl-stream (TS)
- Pulls the weighted leaderboard selection from hl-scout and mirrors those addresses' Hyperliquid realtime feeds.
- Exposes `/ws` with the legacy event queue semantics.
- Emits authentic BTC/ETH fills for tracked addresses → `c.fills.v1` + WS broadcast.
- Swagger UI at http://localhost:4102/docs.
- Serves the operator dashboard at `/dashboard` with:
  - Real-time position tracking with status polling
  - Infinite scroll fills history with aggregation
  - Historical fills backfill from Hyperliquid API
  - Links to [Hypurrscan](https://hypurrscan.io) for address details

### hl-sage (Py/FastAPI)
- Subscribes to `a.candidates.v1`, computes deterministic equal weights, emits `b.scores.v1`.
- `GET /ranks/top?n=20` returns best candidates.
- `/metrics` exposes Prometheus counters/histograms.
- FastAPI docs at http://localhost:4103/docs.

### hl-decide (Py/FastAPI)
- Consumes `b.scores.v1` + `c.fills.v1`, emits `d.signals.v1` with naive majority.
- Persists tickets & time-boxed outcomes in Postgres; publishes `d.outcomes.v1`.
- FastAPI docs at http://localhost:4104/docs.

### Operator Dashboard
Open http://localhost:4102/dashboard to monitor the stack:

- **TradingView Chart**: BTC/ETH toggle with official TradingView widget
- **Top Performance Table**: Win rate, trades, efficiency, realized PnL, live BTC/ETH holdings
- **Live Fills Feed**:
  - Real-time BTC/ETH fills streamed via WebSocket
  - Fill aggregation (groups trades within 1-minute windows)
  - Infinite scroll with pagination for historical data
  - "Load Historical Fills" button to backfill from Hyperliquid API
  - Time range indicator showing oldest to newest fill
- **Decision Panel**: Tickets + outcomes with recommendation card
- **Custom Accounts**: Track up to 3 custom addresses alongside system-selected ones
- **Position Status**: Automatic polling until positions are loaded (max 60s timeout)

## Leaderboard Ingest

`hl-scout` crawls the Hyperliquid leaderboard for the 30-day period. For every refresh it:

1. Fetches the top `LEADERBOARD_TOP_N` addresses sorted by realized PnL.
2. Computes derived metrics (win rate safety, trade efficiency, realized PnL, pnlList consistency) and scores each wallet.
3. Enriches the top `LEADERBOARD_ENRICH_COUNT` entries with Hyperliquid leaderboard details and `portfolio` data, storing stats on `hl_leaderboard_entries` and time-series in `hl_leaderboard_pnl_points`.
4. Persists the scored rows to `hl_leaderboard_entries`, exposes them via `/leaderboard`/`/leaderboard/selected`, and emits `a.candidates.v1` events with weights + metadata.

`hl-stream` consumes the selected list (default 12 addresses) to drive realtime Hyperliquid subscriptions, while `hl-sage` combines the weights with live fills and inferred positions to publish `b.scores.v1` follow signals.

## Development Tips

- Contracts are generated; do not edit `contracts/ts/index.ts` or `contracts/py/models.py` manually.
- Shared TypeScript helpers live in `packages/ts-lib` (NATS wrapper, metrics, address store, Hyperliquid client, etc.).
- `scripts/phase1-plan.md` documents the intent/scope for this phase.

## Recent Improvements (November 2025)

A comprehensive code review identified and fixed 20 issues across critical security, performance, and code quality areas:

### Security & Stability
- ✅ **SQL Injection Protection**: All queries now use parameterized statements
- ✅ **Input Validation**: New validation module for Ethereum addresses with format checking
- ✅ **Transaction Safety**: Leaderboard updates wrapped in database transactions (prevents data loss)
- ✅ **Error Handling**: Comprehensive error logging throughout all services
- ✅ **Python datetime fix**: Replaced deprecated `datetime.utcnow()` with `datetime.now(timezone.utc)`

### Performance Optimizations
- ✅ **Database Indexes**: Added strategic indexes for faster queries (trades, positions, leaderboard)
- ✅ **Memory Management**: Python services now use LRU caching with configurable limits
- ✅ **WebSocket Cleanup**: Fixed memory leaks with proper interval and connection management
- ✅ **Query Optimization**: Removed code duplication in pagination functions

### Code Quality
- ✅ **Type Safety**: Replaced `any` types with `Record<string, unknown>` for better compile-time safety
- ✅ **Promise Handling**: All background promises now have proper error handlers
- ✅ **Configuration**: Added environment variables for memory limits in Python services

### Dashboard & API Enhancements
- ✅ **ETH Support**: Now tracks both BTC and ETH perpetual fills (not just BTC)
- ✅ **Fill Aggregation**: Groups multiple fills within 1-minute windows for cleaner display
- ✅ **Infinite Scroll**: Paginated fills with automatic loading on scroll
- ✅ **Historical Backfill**: Fetch historical fills from Hyperliquid API on demand
- ✅ **Position Polling**: Dashboard polls for position readiness with 60s timeout
- ✅ **External Links**: Address links now point to Hypurrscan for detailed on-chain info

See [CODE_REVIEW_FIXES.md](docs/CODE_REVIEW_FIXES.md) for detailed technical documentation.

### New Environment Variables

Python services now support memory management configuration:

```env
# hl-sage memory limits
MAX_TRACKED_ADDRESSES=1000   # Default: 1000
MAX_SCORES=500               # Default: 500
STALE_THRESHOLD_HOURS=24     # Default: 24

# hl-decide memory limits
MAX_FILLS=500                # Default: 500
```

### Testing

Run the full test suite including new validation tests:

```bash
npm test                      # All tests
npm run test:coverage         # With coverage report
npm test -- validation        # Just validation tests
```

## License
PolyForm Noncommercial 1.0.0 – free for personal/non-commercial use. For commercial licensing, please reach out.
