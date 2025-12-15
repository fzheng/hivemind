-- Phase 6.3: Per-Venue EV Routing
-- Adds execution venue and cost breakdown fields to consensus_signals.

-- Add target exchange column (selected by EV comparison)
ALTER TABLE consensus_signals
    ADD COLUMN IF NOT EXISTS target_exchange VARCHAR(16) DEFAULT 'hyperliquid';

-- Add cost breakdown columns
ALTER TABLE consensus_signals
    ADD COLUMN IF NOT EXISTS fees_bps DECIMAL(10,4) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS slippage_bps DECIMAL(10,4) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS funding_bps DECIMAL(10,4) DEFAULT 0;

-- Update existing rows to have default values
UPDATE consensus_signals
SET target_exchange = 'hyperliquid'
WHERE target_exchange IS NULL;

-- Index for efficient exchange lookups
CREATE INDEX IF NOT EXISTS idx_consensus_signals_target_exchange
    ON consensus_signals(target_exchange);

-- Comments
COMMENT ON COLUMN consensus_signals.target_exchange IS 'Best execution venue selected by EV comparison (Phase 6.3)';
COMMENT ON COLUMN consensus_signals.fees_bps IS 'Trading fees in basis points for the target exchange';
COMMENT ON COLUMN consensus_signals.slippage_bps IS 'Estimated slippage in basis points';
COMMENT ON COLUMN consensus_signals.funding_bps IS 'Expected funding cost/rebate in basis points';
