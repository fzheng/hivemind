-- Migration: Episode fills tracking
--
-- This migration adds a table to track all fills belonging to each episode,
-- enabling proper VWAP calculation for multi-fill entries and exits.
--
-- The episode system builds complete position lifecycles:
-- - Entry fills: All fills that add to the position
-- - Exit fills: All fills that reduce/close the position
--
-- This replaces the single-fill tracking in position_signals with
-- proper multi-fill episode construction.

-- Create episode_fills table to track all fills in an episode
CREATE TABLE IF NOT EXISTS episode_fills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id UUID NOT NULL,  -- References position_signals.id
    fill_id TEXT NOT NULL,
    fill_type TEXT NOT NULL CHECK (fill_type IN ('entry', 'exit')),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    size DOUBLE PRECISION NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    realized_pnl DOUBLE PRECISION,
    fees DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure unique fill per episode
    CONSTRAINT episode_fills_unique UNIQUE (episode_id, fill_id)
);

-- Index for finding fills by episode
CREATE INDEX IF NOT EXISTS idx_episode_fills_episode
    ON episode_fills(episode_id);

-- Index for finding fills by fill_id (for dedup)
CREATE INDEX IF NOT EXISTS idx_episode_fills_fill_id
    ON episode_fills(fill_id);

-- Index for chronological ordering within episode
CREATE INDEX IF NOT EXISTS idx_episode_fills_ts
    ON episode_fills(episode_id, ts);

-- Add episode tracking columns to position_signals if not present
ALTER TABLE position_signals
    ADD COLUMN IF NOT EXISTS entry_fill_count INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS exit_fill_count INTEGER DEFAULT 0;

-- Comment
COMMENT ON TABLE episode_fills IS
    'Tracks all fills belonging to each position episode for VWAP calculation.
    Each episode (position lifecycle) can have multiple entry fills (building position)
    and multiple exit fills (closing position). This enables accurate R-multiple
    calculation using VWAP prices instead of single fill prices.';

COMMENT ON COLUMN episode_fills.fill_type IS 'Whether this fill added to (entry) or reduced (exit) the position';
COMMENT ON COLUMN episode_fills.episode_id IS 'References position_signals.id for the parent episode';
