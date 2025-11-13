-- Shared tables for Phase 1 multi-service rollout
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS marks_1m (
  asset TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  mid NUMERIC NOT NULL,
  atr14 NUMERIC,
  PRIMARY KEY(asset, ts)
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  address TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_ts_idx ON tickets (ts DESC);
CREATE INDEX IF NOT EXISTS tickets_asset_idx ON tickets (asset);

CREATE TABLE IF NOT EXISTS ticket_outcomes (
  ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  closed_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_r DOUBLE PRECISION,
  closed_reason TEXT NOT NULL,
  notes TEXT
);
