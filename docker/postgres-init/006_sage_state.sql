-- Migration 005: hl-sage state persistence
-- Persist tracked address metadata to survive service restarts

CREATE TABLE IF NOT EXISTS sage_tracked_addresses (
  address TEXT PRIMARY KEY,
  weight DOUBLE PRECISION NOT NULL,
  rank INT NOT NULL,
  period INT NOT NULL,
  position DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for cleanup queries (find stale entries)
CREATE INDEX IF NOT EXISTS sage_tracked_addresses_updated_idx
  ON sage_tracked_addresses (updated_at DESC);

-- Comment for documentation
COMMENT ON TABLE sage_tracked_addresses IS 'hl-sage tracked address state for recovery on restart';
COMMENT ON COLUMN sage_tracked_addresses.address IS 'Ethereum address (lowercase)';
COMMENT ON COLUMN sage_tracked_addresses.weight IS 'Score weight from leaderboard';
COMMENT ON COLUMN sage_tracked_addresses.rank IS 'Leaderboard rank';
COMMENT ON COLUMN sage_tracked_addresses.period IS 'Leaderboard period in days';
COMMENT ON COLUMN sage_tracked_addresses.position IS 'Current position size';
COMMENT ON COLUMN sage_tracked_addresses.updated_at IS 'Last update timestamp';
