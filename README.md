# hlbot Platform (Phase 1)

![Coverage](badges/coverage.svg) [![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-brightgreen.svg?style=flat-square)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Phase 1 refactors the legacy single-process tracker into a four-service monorepo with shared Postgres, NATS JetStream, JSON-schema-backed contracts, and an end-to-end fake flow (Candidates → Scores → Fills → Signals → Outcomes).

```
services/
  hl-scout   TypeScript  — address ingest + seeding + candidate emitter
  hl-stream  TypeScript  — watcher/WS + fake fill publisher
  hl-sage    Python      — scoring + ranks API
  hl-decide  Python      — decision engine + tickets/outcomes
contracts/              — jsonschema + generated zod & pydantic bindings
db/migrations           — shared schema (addresses, marks_1m, tickets, ...)
```

## Quick Start

```bash
npm install
cp .env.example .env          # tweak OWNER_TOKEN etc if needed
docker compose up --build
```

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

`db/migrations` contains all SQL (addresses, events, marks_1m, tickets, ticket_outcomes, …). Apply via:
```bash
npm run migrate
npm run migrate:status
```

### New tables
- `marks_1m(asset, ts, mid, atr14)`
- `tickets(id UUID, ts, address, asset, side, payload JSONB)`
- `ticket_outcomes(ticket_id FK, closed_ts, result_r, closed_reason, notes)`

## Environment

Key variables (see `.env.example`):

| Var              | Default                          | Description |
|------------------|----------------------------------|-------------|
| `OWNER_TOKEN`    | `dev-owner`                      | Shared HTTP auth (header `x-owner-key`) |
| `NATS_URL`       | `nats://nats:4222`               | NATS connection string |
| `DATABASE_URL`   | `postgresql://hlbot:...@postgres`| Postgres DSN |
| `SCOUT_SEEDS`    | 3 demo 0x addresses              | Initial candidates emitted on boot |
| `SCOUT_URL`      | `http://hl-scout:8080`           | Used by hl-stream to refresh watchlist |
| `*_PORT`         | `410{1-4}`                       | Host-forwarded HTTP ports |

Compose keeps everything on an isolated bridge network and only binds owner HTTP ports to `127.0.0.1`.

## Tooling

| Script                 | Purpose |
|------------------------|---------|
| `npm run build`        | TypeScript project references + `tsc-alias` |
| `npm run dev:scout`    | Watch mode for hl-scout |
| `npm run dev:stream`   | Watch mode for hl-stream |
| `npm run contracts:generate` | Rebuild zod/pydantic bindings |
| `npm run e2e-smoke`    | Seed + wait for Candidate→Outcome flow |
| `npm run migrate`      | Apply SQL migrations |

## Service Notes

### hl-scout (TS)
- Express API for addresses (`GET/POST/DELETE /addresses`).
- `POST /admin/seed` & `/admin/backfill/:address` require `x-owner-key`.
- Publishes `a.candidates.v1` for seeds and new additions.
- Reuses Hyperliquid info/backfill helpers to warm Postgres (`hl_events`).  
- Swagger UI at http://localhost:4101/docs.

### hl-stream (TS)
- Watches hl-scout for address updates via `POST /watchlist/refresh`.
- Exposes `/ws` with the legacy event queue semantics.
- Emits fake fills every second per watched address → `c.fills.v1` + WS broadcast.
- Swagger UI at http://localhost:4102/docs.

### hl-sage (Py/FastAPI)
- Subscribes to `a.candidates.v1`, computes deterministic equal weights, emits `b.scores.v1`.
- `GET /ranks/top?n=20` returns best candidates.
- `/metrics` exposes Prometheus counters/histograms.
- FastAPI docs at http://localhost:4103/docs.

### hl-decide (Py/FastAPI)
- Consumes `b.scores.v1` + `c.fills.v1`, emits `d.signals.v1` with naive majority.
- Persists tickets & time-boxed outcomes in Postgres; publishes `d.outcomes.v1`.
- FastAPI docs at http://localhost:4104/docs.

## Development Tips

- Contracts are generated; do not edit `contracts/ts/index.ts` or `contracts/py/models.py` manually.
- Shared TypeScript helpers live in `packages/ts-lib` (NATS wrapper, metrics, address store, Hyperliquid client, etc.).
- `scripts/phase1-plan.md` documents the intent/scope for this phase.

## License
PolyForm Noncommercial 1.0.0 – free for personal/non-commercial use. For commercial licensing, please reach out.
