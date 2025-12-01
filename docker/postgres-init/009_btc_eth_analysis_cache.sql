-- BTC/ETH analysis cache table
-- Caches results from Hyperbot API to reduce rate limiting issues
-- Cache entries expire after 30 days

CREATE TABLE IF NOT EXISTS hl_btc_eth_analysis_cache (
    address TEXT PRIMARY KEY,
    btc_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    eth_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    btc_eth_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    btc_eth_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
    qualified BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS hl_btc_eth_analysis_cache_expires_idx
ON hl_btc_eth_analysis_cache(expires_at);

-- Comment
COMMENT ON TABLE hl_btc_eth_analysis_cache IS 'Cache for BTC/ETH trading analysis from Hyperbot API, expires after 30 days';
