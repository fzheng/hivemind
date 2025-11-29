# API Reference

HyperMind exposes REST APIs and WebSocket endpoints across its services. Each service provides interactive Swagger documentation at `/docs`.

## Service URLs

| Service | Swagger UI | Base URL |
|---------|------------|----------|
| hl-scout | http://localhost:4101/docs | `http://localhost:4101` |
| hl-stream | http://localhost:4102/docs | `http://localhost:4102` |
| hl-sage | http://localhost:4103/docs | `http://localhost:4103` |
| hl-decide | http://localhost:4104/docs | `http://localhost:4104` |

## Authentication

Protected endpoints require the `x-owner-key` header:

```bash
curl -H "x-owner-key: YOUR_OWNER_TOKEN" http://localhost:4101/addresses
```

The token is set via `OWNER_TOKEN` environment variable.

---

## hl-scout API (Port 4101)

Leaderboard scanning and address management.

### Health & Metrics

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/healthz` | GET | No | Service health check |
| `/metrics` | GET | No | Prometheus metrics |

### Leaderboard

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/leaderboard` | GET | No | Get leaderboard entries |
| `/leaderboard/selected` | GET | Yes | Get top-ranked selected traders |
| `/leaderboard/refresh` | POST | Yes | Force leaderboard refresh |

**Query Parameters for `/leaderboard`:**
- `period` - Period in days (default: 30)
- `limit` - Max entries to return (default: 20)

### Custom Accounts

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/custom-accounts` | GET | No | List custom accounts (max 3) |
| `/custom-accounts` | POST | No | Add custom account |
| `/custom-accounts/:address` | DELETE | No | Remove custom account |
| `/custom-accounts/:address/nickname` | PUT | No | Update nickname |

**POST `/custom-accounts` Body:**
```json
{
  "address": "0x...",
  "nickname": "Optional Name"
}
```

### Addresses (Legacy)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/addresses` | GET | No | List tracked addresses |
| `/addresses` | POST | Yes | Add address |
| `/addresses/:address` | DELETE | Yes | Remove address |
| `/addresses/seed` | POST | Yes | Seed multiple addresses |

### Data Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/fills` | GET | No | Recent trade fills |
| `/fills/:address` | GET | No | Fills for specific address |
| `/decisions` | GET | No | Recent AI decisions |

---

## hl-stream API (Port 4102)

Real-time feeds and dashboard.

### Health & Metrics

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/healthz` | GET | No | Service health check |
| `/metrics` | GET | No | Prometheus metrics |

### Dashboard

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/dashboard` | GET | No | Web dashboard UI |
| `/dashboard/static/*` | GET | No | Static assets |

### Watchlist

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/watchlist` | GET | No | Current tracked addresses |
| `/watchlist/refresh` | POST | Yes | Refresh from hl-scout |

### Fills Data

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/fills` | GET | No | Recent fills with pagination |
| `/fills/backfill` | GET | No | Paginated historical fills |
| `/fills/validate` | GET | No | Validate position chain integrity |
| `/fills/repair` | POST | No | Repair data for a specific address |
| `/fills/repair-all` | POST | No | Auto-repair all invalid addresses |

**Query Parameters for `/fills`:**
- `limit` - Max fills (default: 40, max: 200)

**Query Parameters for `/fills/backfill`:**
- `before` - ISO timestamp for pagination
- `limit` - Max fills (default: 50, max: 100)

**Query Parameters for `/fills/validate`:**
- `symbol` - Asset symbol (`BTC` or `ETH`, default: `ETH`)

**POST `/fills/repair` Body:**
```json
{
  "address": "0x...",
  "symbol": "ETH"
}
```

**POST `/fills/repair-all` Body:**
```json
{
  "symbol": "ETH"
}
```

### Prices

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/prices` | GET | No | Current BTC/ETH prices |

### Positions

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/positions/status` | GET | No | Position tracking status |

### WebSocket

| Endpoint | Description |
|----------|-------------|
| `ws://localhost:4102/ws` | Real-time event stream |

**WebSocket Message Format:**
```json
{
  "events": [
    {
      "type": "trade",
      "seq": 123,
      "at": "2025-01-01T00:00:00Z",
      "address": "0x...",
      "symbol": "BTC",
      "side": "buy",
      "priceUsd": 95000,
      "size": 0.1
    }
  ]
}
```

---

## hl-sage API (Port 4103)

Score computation service (Python/FastAPI).

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/healthz` | GET | No | Service health |
| `/metrics` | GET | No | Prometheus metrics |
| `/scores` | GET | No | Current computed scores |

---

## hl-decide API (Port 4104)

Signal generation service (Python/FastAPI).

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/healthz` | GET | No | Service health |
| `/metrics` | GET | No | Prometheus metrics |
| `/signals` | GET | No | Recent generated signals |
| `/outcomes` | GET | No | Signal outcomes |

---

## NATS Message Topics

Internal pub/sub messaging between services:

| Topic | Publisher | Consumer | Description |
|-------|-----------|----------|-------------|
| `a.candidates.v1` | hl-scout | hl-sage | Candidate trader events |
| `b.scores.v1` | hl-sage | hl-decide | Computed scores |
| `c.fills.v1` | hl-stream | hl-decide | Real-time fill events |
| `d.signals.v1` | hl-decide | - | Generated signals |
| `d.outcomes.v1` | hl-decide | - | Signal outcomes |

---

## Error Responses

All APIs return consistent error format:

```json
{
  "error": "Error message description"
}
```

**HTTP Status Codes:**
- `200` - Success
- `400` - Bad request / validation error
- `403` - Forbidden (missing/invalid auth)
- `404` - Not found
- `500` - Internal server error
