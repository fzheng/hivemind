## Phase 1 Monorepo Refactor (hlbot → hl-platform)

This document captures the target layout and responsibilities for the Phase 1 refactor into four services with shared infra.

### Repo Layout

```
/contracts/jsonschema        # Canonical message contracts (v1)
/contracts/ts                # Generated zod bindings
/contracts/py                # Generated pydantic models
/db/migrations               # Postgres migrations (shared schema)
/scripts                     # Tooling (migrate, codegen, e2e smoke)
/services
  /hl-scout (TypeScript)     # Address ingest + seeding + candidate emitter
  /hl-stream (TypeScript)    # Hyperliquid WS watcher + fill publisher
  /hl-sage  (Python)         # Scoring + ranks API
  /hl-decide (Python)        # Decision engine + ticket/outcome writer
```

All services expose `/healthz` and `/metrics`, and ship Dockerfiles. Shared infra comes from `docker-compose.yml` (Postgres 16 + NATS JetStream on a private bridge network). Owner HTTP ports bind to `127.0.0.1`.

### Message Topology (JetStream/NATS)

| Topic          | Publisher  | Consumer(s) | Purpose |
|----------------|------------|-------------|---------|
| `a.candidates.v1` | hl-scout | hl-sage      | Seed/backfill/daily candidates |
| `b.scores.v1`     | hl-sage  | hl-decide    | Normalized score snapshots |
| `c.fills.v1`      | hl-stream | hl-decide   | Normalized fills (fake timer + optional real addr) |
| `d.signals.v1`    | hl-decide | (persist)   | Ticket creation notices |
| `d.outcomes.v1`   | hl-decide | (persist)   | Ticket closes/outcomes |

Schema definitions live under `/contracts/jsonschema`; TS/Py bindings are generated (zod + pydantic) via `scripts/generate-contracts.ts`.

### Service Responsibilities

- **hl-scout (TS)**  
  - Owns address storage + seeds/backfill helpers from legacy hlbot.  
  - HTTP: `GET/POST/DELETE /addresses`, `POST /admin/seed`.  
  - On startup and on admin seed, publishes stub `a.candidates.v1` for at least 3 addresses.  
  - Supplies `/healthz` + `/metrics` (Prometheus).

- **hl-sage (Py)**  
  - NATS consumer for candidates.  
  - Maintains in-memory rank table + persists last weights.  
  - Publishes equal-weight `b.scores.v1`.  
  - HTTP: `GET /ranks/top?n=20` to display ranked candidates.  
  - `/healthz` + `/metrics`.

- **hl-stream (TS)**  
  - Owns Hyperliquid WS client & `/ws` plumbing moved from hlbot.  
  - HTTP: `POST /watchlist/refresh` to pull latest addresses from hl-scout.  
  - Publishes fake `c.fills.v1` every 1s (timer) with optional passthrough from one real address (for latency SLO checks).  
  - `/healthz` + `/metrics`.

- **hl-decide (Py)**  
  - Consumes `b.scores.v1` + `c.fills.v1`.  
  - Naive consensus (majority long/short) creates tickets stored in Postgres.  
  - Emits `d.signals.v1` for created tickets, and closes them via timebox to emit `d.outcomes.v1`.  
  - `/healthz` + `/metrics`.

### Database Schema (shared)

Existing hlbot migrations move into `/db/migrations`. New tables:

- `marks_1m(asset TEXT, ts TIMESTAMPTZ, mid NUMERIC, atr14 NUMERIC, PRIMARY KEY(asset, ts))`
- `tickets(id UUID PRIMARY KEY, ts TIMESTAMPTZ, asset TEXT, side TEXT, payload JSONB)`
- `ticket_outcomes(ticket_id UUID REFERENCES tickets(id), closed_ts TIMESTAMPTZ, result_r DOUBLE PRECISION, closed_reason TEXT)`

### Tooling & SLOs

- `scripts/migrate.js` now reads `/db/migrations`.  
- `scripts/generate-contracts.ts` builds bindings (used by TS build + Python services).  
- `scripts/e2e-smoke.ts` drives the expected flow: seed via hl-scout, wait for `Candidates → Scores → Fills → Signal → Outcome`.  
- Publish/consume p95 < 150 ms, WS→publish p95 < 500 ms (tracked via Prometheus histograms).

This document should stay in sync with implementation for Phase 1.
