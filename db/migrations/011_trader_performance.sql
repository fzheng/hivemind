-- Migration 011: Trader performance tracking for multi-armed bandit
-- Stores per-trader outcome statistics used by Thompson Sampling algorithm
-- to learn which traders to follow based on signal outcomes.
--
-- Bayesian approach:
-- - alpha/beta parameters form a Beta distribution prior
-- - alpha = successes + 1, beta = failures + 1
-- - Start with Beta(1,1) = uniform prior (no bias)
-- - Update after each signal outcome

CREATE TABLE IF NOT EXISTS trader_performance (
  address TEXT PRIMARY KEY,

  -- Signal statistics
  total_signals INT NOT NULL DEFAULT 0,
  winning_signals INT NOT NULL DEFAULT 0,
  total_pnl_r DOUBLE PRECISION NOT NULL DEFAULT 0,  -- Sum of R-multiples
  avg_hold_time_s INT,
  last_signal_at TIMESTAMPTZ,

  -- Bayesian prior parameters (Beta distribution)
  -- Thompson Sampling samples from Beta(alpha, beta)
  alpha DOUBLE PRECISION NOT NULL DEFAULT 1,  -- Successes + 1
  beta DOUBLE PRECISION NOT NULL DEFAULT 1,   -- Failures + 1

  -- Risk metrics
  max_drawdown DOUBLE PRECISION DEFAULT 0,
  sharpe_ratio DOUBLE PRECISION,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for finding top performers by win rate (alpha / (alpha + beta))
CREATE INDEX IF NOT EXISTS trader_performance_win_rate_idx
  ON trader_performance ((alpha / (alpha + beta)) DESC)
  WHERE total_signals >= 5;

-- Index for recent activity
CREATE INDEX IF NOT EXISTS trader_performance_updated_idx
  ON trader_performance (updated_at DESC);

-- Index for finding traders with minimum sample size
CREATE INDEX IF NOT EXISTS trader_performance_signals_idx
  ON trader_performance (total_signals DESC);

-- Comments
COMMENT ON TABLE trader_performance IS 'Per-trader signal outcome statistics for Thompson Sampling bandit algorithm';
COMMENT ON COLUMN trader_performance.address IS 'Ethereum address (lowercase)';
COMMENT ON COLUMN trader_performance.total_signals IS 'Total number of signals attributed to this trader';
COMMENT ON COLUMN trader_performance.winning_signals IS 'Number of profitable signals (result_r > 0)';
COMMENT ON COLUMN trader_performance.total_pnl_r IS 'Cumulative P&L in R-multiples';
COMMENT ON COLUMN trader_performance.alpha IS 'Beta distribution alpha parameter (successes + 1)';
COMMENT ON COLUMN trader_performance.beta IS 'Beta distribution beta parameter (failures + 1)';
COMMENT ON COLUMN trader_performance.max_drawdown IS 'Maximum drawdown observed';
COMMENT ON COLUMN trader_performance.sharpe_ratio IS 'Sharpe ratio of signals';
