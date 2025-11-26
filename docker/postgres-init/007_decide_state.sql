-- Migration 006: hl-decide state persistence
-- Persist scores and fills to survive service restarts

CREATE TABLE IF NOT EXISTS decide_scores (
  address TEXT PRIMARY KEY,
  score DOUBLE PRECISION NOT NULL,
  weight DOUBLE PRECISION NOT NULL,
  rank INT NOT NULL,
  window_s INT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  meta JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decide_fills (
  address TEXT PRIMARY KEY,
  fill_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  price DOUBLE PRECISION,
  ts TIMESTAMPTZ NOT NULL,
  meta JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for cleanup queries
CREATE INDEX IF NOT EXISTS decide_scores_updated_idx ON decide_scores (updated_at DESC);
CREATE INDEX IF NOT EXISTS decide_fills_updated_idx ON decide_fills (updated_at DESC);

-- Comments
COMMENT ON TABLE decide_scores IS 'hl-decide score state for recovery on restart';
COMMENT ON TABLE decide_fills IS 'hl-decide fill state for recovery on restart';
