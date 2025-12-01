-- Migration 010: Pinned accounts (replaces custom accounts)
-- Allows users to pin accounts from leaderboard (unlimited) or add custom accounts (max 3)
--
-- Pin types:
-- - is_custom = false: Pinned from leaderboard (unlimited, excluded from top-10 selection)
-- - is_custom = true: Custom added account (max 3, excluded from top-10 selection)
--
-- When unpinned:
-- - is_custom = false: Account is removed from pinned list, may reappear in top-10 if qualified
-- - is_custom = true: Account is completely removed

-- Create hl_pinned_accounts table (replacement for hl_custom_accounts)
CREATE TABLE IF NOT EXISTS hl_pinned_accounts (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  is_custom BOOLEAN NOT NULL DEFAULT false,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on lowercase address (prevents duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS hl_pinned_accounts_address_unique ON hl_pinned_accounts (lower(address));

-- Index for filtering by is_custom
CREATE INDEX IF NOT EXISTS hl_pinned_accounts_is_custom_idx ON hl_pinned_accounts (is_custom);

-- Migrate data from hl_custom_accounts to hl_pinned_accounts (if old table exists)
-- All existing custom accounts become is_custom = true
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hl_custom_accounts') THEN
    INSERT INTO hl_pinned_accounts (address, is_custom, pinned_at)
    SELECT address, true, added_at FROM hl_custom_accounts
    ON CONFLICT (lower(address)) DO NOTHING;
  END IF;
END $$;

-- Comment for documentation
COMMENT ON TABLE hl_pinned_accounts IS 'User-pinned accounts for tracking. is_custom=true for manually added (max 3), is_custom=false for pinned from leaderboard (unlimited)';
COMMENT ON COLUMN hl_pinned_accounts.address IS 'Ethereum address (stored lowercase)';
COMMENT ON COLUMN hl_pinned_accounts.is_custom IS 'Whether this was manually added (true) or pinned from leaderboard (false)';
COMMENT ON COLUMN hl_pinned_accounts.pinned_at IS 'When the account was pinned';
