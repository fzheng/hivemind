import type { Pool } from 'pg';
import { getPool as getSharedPool } from './postgres';

let poolPromise: Promise<Pool> | null = null;

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = getSharedPool();
  }
  return poolPromise;
}

export type InsertableEvent = {
  type: 'position' | 'trade';
  at: string; // ISO
  address: string;
  symbol: 'BTC' | 'ETH';
  payload: Record<string, unknown>; // stored as JSON
};

export async function insertEvent(evt: InsertableEvent): Promise<number | null> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      'insert into hl_events (at, address, type, symbol, payload) values ($1,$2,$3,$4,$5) returning id',
      [evt.at, evt.address, evt.type, evt.symbol, evt.payload]
    );
    return rows?.[0]?.id ?? null;
  } catch (e) {
    console.error('[persist] insertEvent failed:', { type: evt.type, address: evt.address, error: e });
    return null;
  }
}

export async function clearPositionsForAddress(address: string): Promise<void> {
  try {
    const p = await getPool();
    await p.query(
      'DELETE FROM hl_current_positions WHERE address = $1',
      [address]
    );
  } catch (e) {
    console.error('[persist] clearPositionsForAddress failed:', { address, error: e });
  }
}

export async function upsertCurrentPosition(args: {
  address: string;
  symbol: 'BTC' | 'ETH';
  size: number;
  entryPriceUsd: number | null;
  liquidationPriceUsd: number | null;
  leverage: number | null;
  pnlUsd: number | null;
  updatedAt?: string; // ISO
}): Promise<void> {
  try {
    const p = await getPool();

    // If position is closed (size = 0), delete the record
    if (args.size === 0) {
      await p.query(
        'DELETE FROM hl_current_positions WHERE address = $1 AND symbol = $2',
        [args.address, args.symbol]
      );
      return;
    }

    // Otherwise upsert the position
    await p.query(
      `insert into hl_current_positions(address, symbol, size, entry_price, liquidation_price, leverage, pnl, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict(address, symbol) do update set
         size=excluded.size,
         entry_price=excluded.entry_price,
         liquidation_price=excluded.liquidation_price,
         leverage=excluded.leverage,
         pnl=excluded.pnl,
         updated_at=excluded.updated_at` ,
      [
        args.address,
        args.symbol,
        args.size,
        args.entryPriceUsd,
        args.liquidationPriceUsd,
        args.leverage,
        args.pnlUsd,
        args.updatedAt || new Date().toISOString(),
      ]
    );
  } catch (e) {
    console.error('[persist] upsertCurrentPosition failed:', { address: args.address, error: e });
  }
}

export async function latestTrades(limit = 50): Promise<Record<string, unknown>[]> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      'select payload from hl_events where type = $1 order by id desc limit $2',
      ['trade', Math.max(1, Math.min(200, limit))]
    );
    return rows.map((r: any) => r.payload);
  } catch (_e) {
    return [];
  }
}

// Time-based pagination (preferred for chronological ordering). Optional beforeAt ISO cursor.
export async function pageTradesByTime(opts: { limit?: number; beforeAt?: string | null; beforeId?: number | null; address?: string | null }): Promise<{ id: number; address: string; at: string; payload: Record<string, unknown> }[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  try {
    const p = await getPool();
    const clauses: string[] = ["type = 'trade'"]; const params: any[] = []; let idx = 1;
    if (opts.address) { clauses.push(`address = $${idx++}`); params.push(String(opts.address).toLowerCase()); }
    if (opts.beforeAt && opts.beforeId != null) {
      clauses.push(`(at < $${idx} OR (at = $${idx} AND id < $${idx + 1}))`);
      params.push(opts.beforeAt, opts.beforeId);
      idx += 2;
    } else if (opts.beforeAt) {
      clauses.push(`at < $${idx++}`);
      params.push(opts.beforeAt);
    } else if (opts.beforeId != null) {
      clauses.push(`id < $${idx++}`);
      params.push(opts.beforeId);
    }
    const where = clauses.length ? 'where ' + clauses.join(' and ') : '';
    params.push(limit);
    const sql = `select id, address, at, payload from hl_events ${where} order by at desc, id desc limit $${idx}`;
    const { rows } = await p.query(sql, params);
    return rows as any[];
  } catch (e) {
    console.error('[persist] pageTradesByTime failed:', e);
    return [];
  }
}

export async function deleteAllTrades(): Promise<number> {
  try {
    const p = await getPool();
    const { rowCount } = await p.query("delete from hl_events where type = 'trade'");
    return rowCount ?? 0;
  } catch (_e) {
    return 0;
  }
}

export interface InsertTradeResult {
  id: number | null;
  inserted: boolean;
}

export async function insertTradeIfNew(address: string, payload: Record<string, unknown>): Promise<InsertTradeResult> {
  try {
    const p = await getPool();
    const addr = address.toLowerCase();
    const hash = payload?.hash || payload?.tx || null;
    if (hash) {
      const { rows } = await p.query(
        "select id from hl_events where type = 'trade' and address = $1 and payload->>'hash' = $2 limit 1",
        [addr, String(hash)]
      );
      if (rows.length > 0) {
        // Update existing payload to the newer (e.g., aggregated) one
        const targetId = Number(rows[0].id);
        await p.query('update hl_events set at = $1, payload = $2 where id = $3', [payload.at || new Date().toISOString(), payload, targetId]);
        return { id: targetId, inserted: false };
      }
    }
    const { rows } = await p.query(
      'insert into hl_events (at, address, type, symbol, payload) values ($1,$2,$3,$4,$5) returning id',
      [payload.at || new Date().toISOString(), addr, 'trade', payload.symbol || 'BTC', payload]
    );
    return { id: rows?.[0]?.id ?? null, inserted: true };
  } catch (_e) {
    return { id: null, inserted: false };
  }
}

export async function pageTrades(opts: { limit?: number; beforeId?: number | null; address?: string | null }): Promise<{ id: number; payload: Record<string, unknown> }[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  try {
    const p = await getPool();
    const clauses: string[] = ["type = 'trade'"];
    const params: any[] = [];
    let idx = 1;

    if (opts.address) {
      clauses.push(`address = $${idx++}`);
      params.push(opts.address.toLowerCase());
    }
    if (opts.beforeId != null) {
      clauses.push(`id < $${idx++}`);
      params.push(opts.beforeId);
    }

    params.push(limit);
    const where = clauses.join(' and ');
    const sql = `select id, payload from hl_events where ${where} order by id desc limit $${idx}`;
    const { rows } = await p.query(sql, params);
    return rows as any[];
  } catch (e) {
    console.error('[persist] pageTrades failed:', e);
    return [];
  }
}

export async function countValidTradesForAddress(address: string): Promise<number> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      "select count(1)::int as c from hl_events where type = 'trade' and address = $1 and (payload ? 'startPosition') and (payload->>'startPosition') is not null",
      [address.toLowerCase()]
    );
    return Number(rows?.[0]?.c ?? 0);
  } catch (_e) {
    return 0;
  }
}

export async function deleteTradesForAddress(address: string): Promise<number> {
  try {
    const p = await getPool();
    const { rowCount } = await p.query(
      "delete from hl_events where type = 'trade' and address = $1",
      [address.toLowerCase()]
    );
    return rowCount ?? 0;
  } catch (_e) {
    return 0;
  }
}

export interface AddressPerformance {
  address: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl7d: number;
  avgSize: number;
  efficiency: number;
}

export async function getAddressPerformance(days = 7): Promise<AddressPerformance[]> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
        select
          address,
          count(*) as trades,
          sum(case when (payload->>'realizedPnlUsd')::numeric > 0 then 1 else 0 end) as wins,
          coalesce(sum((payload->>'realizedPnlUsd')::numeric),0) as pnl_total,
          coalesce(sum(case when at >= now() - $1::interval then (payload->>'realizedPnlUsd')::numeric else 0 end),0) as pnl_7d,
          coalesce(avg((payload->>'size')::numeric),0) as avg_size
        from hl_events
        where type = 'trade'
        group by address
        order by pnl_7d desc, address asc
      `,
      [`${Math.max(1, days)} days`]
    );
    return rows.map((row: any) => {
      const trades = Number(row.trades) || 0;
      const wins = Number(row.wins) || 0;
      const pnlTotal = Number(row.pnl_total) || 0;
      const efficiency = trades > 0 ? pnlTotal / trades : pnlTotal;
      return {
        address: row.address,
        trades,
        wins,
        winRate: trades ? wins / trades : 0,
        pnl7d: Number(row.pnl_7d) || 0,
        avgSize: Number(row.avg_size) || 0,
        efficiency,
      };
    });
  } catch (_e) {
    return [];
  }
}

export interface RecentFill {
  id: number;
  address: string;
  at: string;
  side: 'buy' | 'sell';
  size: number;
  priceUsd: number;
  realizedPnlUsd: number | null;
  action?: string | null;
}

export async function listRecentFills(limit = 25): Promise<RecentFill[]> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
        select id, address, at, payload
        from hl_events
        where type = 'trade'
        order by at desc, id desc
        limit $1
      `,
      [Math.max(1, Math.min(200, limit))]
    );
    return rows.map((row: any) => ({
      id: Number(row.id),
      address: row.address,
      at: row.at,
      side: ((row.payload?.side === 'sell') ? 'sell' : 'buy') as 'buy' | 'sell',
      size: Number(row.payload?.size ?? row.payload?.payload?.size ?? 0),
      priceUsd: Number(row.payload?.priceUsd ?? row.payload?.price ?? 0),
      realizedPnlUsd: row.payload?.realizedPnlUsd != null ? Number(row.payload?.realizedPnlUsd) : null,
      action: row.payload?.action ?? null,
    }));
  } catch (_e) {
    return [];
  }
}

export interface LiveFill {
  time_utc: string;
  address: string;
  action: string;
  size_signed: number | null;
  previous_position: number | null;
  price_usd: number | null;
  closed_pnl_usd: number | null;
  tx_hash: string | null;
  symbol?: string | null;
  fee?: number | null;
  fee_token?: string | null;
}

export async function listLiveFills(limit = 25): Promise<LiveFill[]> {
  const safeLimit = Math.max(1, Math.min(200, limit));
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
        SELECT
          COALESCE((payload->>'at')::timestamptz, at) AS time_utc,
          address,
          payload->>'action' AS action,
          CASE payload->>'action'
            WHEN 'Increase Long'  THEN (payload->>'size')::numeric
            WHEN 'Decrease Short' THEN (payload->>'size')::numeric
            WHEN 'Close Short'    THEN (payload->>'size')::numeric
            WHEN 'Decrease Long'  THEN -(payload->>'size')::numeric
            WHEN 'Close Long'     THEN -(payload->>'size')::numeric
            WHEN 'Increase Short' THEN -(payload->>'size')::numeric
            ELSE (payload->>'size')::numeric
          END AS size_signed,
          (payload->>'startPosition')::numeric AS previous_position,
          -- Calculate resulting_position = startPosition + position_delta
          -- startPosition is already signed (negative for shorts)
          -- For longs: buy adds to position, sell subtracts
          -- For shorts: buy (cover) makes less negative, sell makes more negative
          (payload->>'startPosition')::numeric +
          CASE payload->>'action'
            WHEN 'Increase Long'  THEN (payload->>'size')::numeric   -- buy adds
            WHEN 'Open Long'      THEN (payload->>'size')::numeric   -- buy adds
            WHEN 'Decrease Long'  THEN -(payload->>'size')::numeric  -- sell subtracts
            WHEN 'Close Long'     THEN -(payload->>'size')::numeric  -- sell subtracts
            WHEN 'Increase Short' THEN -(payload->>'size')::numeric  -- sell makes more negative
            WHEN 'Open Short'     THEN -(payload->>'size')::numeric  -- sell makes negative
            WHEN 'Decrease Short' THEN (payload->>'size')::numeric   -- buy makes less negative
            WHEN 'Close Short'    THEN (payload->>'size')::numeric   -- buy closes to 0
            ELSE (payload->>'size')::numeric
          END AS resulting_position,
          (payload->>'priceUsd')::numeric      AS price_usd,
          (payload->>'realizedPnlUsd')::numeric AS closed_pnl_usd,
          payload->>'hash'                     AS tx_hash,
          payload->>'symbol'                   AS symbol,
          (payload->>'fee')::numeric           AS fee,
          payload->>'feeToken'                 AS fee_token
        FROM hl_events
        WHERE type = 'trade'
        ORDER BY time_utc DESC, id DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows.map((row: any) => ({
      time_utc: row.time_utc,
      address: row.address,
      action: row.action,
      size_signed: row.size_signed != null ? Number(row.size_signed) : null,
      previous_position: row.previous_position != null ? Number(row.previous_position) : null,
      resulting_position: row.resulting_position != null ? Number(row.resulting_position) : null,
      price_usd: row.price_usd != null ? Number(row.price_usd) : null,
      closed_pnl_usd: row.closed_pnl_usd != null ? Number(row.closed_pnl_usd) : null,
      tx_hash: row.tx_hash || null,
      symbol: row.symbol || null,
      fee: row.fee != null ? Number(row.fee) : null,
      fee_token: row.fee_token || null,
    }));
  } catch (_e) {
    return [];
  }
}

export interface DecisionRecord {
  id: string;
  address: string;
  asset: string;
  side: string;
  ts: string;
  status: 'open' | 'closed';
  closedReason?: string | null;
  result?: number | null;
}

export async function listRecentDecisions(limit = 20): Promise<DecisionRecord[]> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
        select
          t.id,
          t.address,
          t.asset,
          t.side,
          t.ts,
          o.closed_reason,
          o.result_r,
          o.closed_ts
        from tickets t
        left join ticket_outcomes o on o.ticket_id = t.id
        order by t.ts desc
        limit $1
      `,
      [Math.max(1, Math.min(100, limit))]
    );
    return rows.map((row: any) => ({
      id: row.id,
      address: row.address,
      asset: row.asset,
      side: row.side,
      ts: row.ts,
      status: row.closed_reason ? 'closed' : 'open',
      closedReason: row.closed_reason,
      result: row.result_r != null ? Number(row.result_r) : null
    }));
  } catch (_e) {
    return [];
  }
}

export async function fetchLatestFillForAddress(address: string): Promise<RecentFill | null> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
        select id, address, at, payload
        from hl_events
        where type = 'trade'
          and address = $1
        order by at desc
        limit 1
      `,
      [address.toLowerCase()]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      address: row.address,
      at: row.at,
      side: ((row.payload?.side === 'sell') ? 'sell' : 'buy') as 'buy' | 'sell',
      size: Number(row.payload?.size ?? 0),
      priceUsd: Number(row.payload?.priceUsd ?? 0),
      realizedPnlUsd: row.payload?.realizedPnlUsd != null ? Number(row.payload?.realizedPnlUsd) : null,
      action: row.payload?.action ?? null,
    };
  } catch (_e) {
    return null;
  }
}

// =====================
// Pinned Accounts Management
// =====================

const MAX_CUSTOM_PINNED_ACCOUNTS = 3;

export interface PinnedAccount {
  id: number;
  address: string;
  isCustom: boolean;
  pinnedAt: string;
}

/**
 * Get all pinned accounts
 * @param isCustom - Optional filter: true for custom only, false for leaderboard-pinned only, undefined for all
 */
export async function listPinnedAccounts(isCustom?: boolean): Promise<PinnedAccount[]> {
  try {
    const p = await getPool();
    let sql = `SELECT id, address, is_custom, pinned_at FROM hl_pinned_accounts`;
    const params: boolean[] = [];
    if (isCustom !== undefined) {
      sql += ` WHERE is_custom = $1`;
      params.push(isCustom);
    }
    sql += ` ORDER BY pinned_at ASC`;
    const { rows } = await p.query(sql, params);
    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      address: String(row.address),
      isCustom: Boolean(row.is_custom),
      pinnedAt: String(row.pinned_at),
    }));
  } catch (e) {
    console.error('[persist] listPinnedAccounts failed:', e);
    return [];
  }
}

/**
 * Pin an account from leaderboard (unlimited)
 * @returns The pinned account or error
 */
export async function pinLeaderboardAccount(
  address: string
): Promise<{ success: boolean; account?: PinnedAccount; error?: string }> {
  try {
    const p = await getPool();
    const normalizedAddress = address.toLowerCase();

    const { rows } = await p.query(
      `INSERT INTO hl_pinned_accounts (address, is_custom)
       VALUES ($1, false)
       ON CONFLICT (lower(address)) DO NOTHING
       RETURNING id, address, is_custom, pinned_at`,
      [normalizedAddress]
    );

    if (!rows.length) {
      return { success: false, error: 'Account is already pinned' };
    }

    return {
      success: true,
      account: {
        id: Number(rows[0].id),
        address: String(rows[0].address),
        isCustom: Boolean(rows[0].is_custom),
        pinnedAt: String(rows[0].pinned_at),
      },
    };
  } catch (e) {
    console.error('[persist] pinLeaderboardAccount failed:', e);
    return { success: false, error: 'Failed to pin account' };
  }
}

/**
 * Add a custom pinned account (max 3 allowed)
 * Uses SHARE ROW EXCLUSIVE lock to serialize inserts and prevent race conditions.
 * @returns The added account or error
 */
export async function addCustomPinnedAccount(
  address: string
): Promise<{ success: boolean; account?: PinnedAccount; error?: string }> {
  const p = await getPool();
  const client = await p.connect();
  try {
    const normalizedAddress = address.toLowerCase();

    await client.query('BEGIN');

    // Acquire exclusive lock to serialize all insert attempts
    await client.query('LOCK TABLE hl_pinned_accounts IN SHARE ROW EXCLUSIVE MODE');

    // Count custom accounts only
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*) as cnt FROM hl_pinned_accounts WHERE is_custom = true'
    );
    const customCount = Number(countRows[0]?.cnt ?? 0);

    if (customCount >= MAX_CUSTOM_PINNED_ACCOUNTS) {
      await client.query('ROLLBACK');
      return { success: false, error: `Maximum of ${MAX_CUSTOM_PINNED_ACCOUNTS} custom accounts allowed` };
    }

    // Check if already exists (as any type)
    const { rows: existing } = await client.query(
      'SELECT 1 FROM hl_pinned_accounts WHERE lower(address) = $1',
      [normalizedAddress]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Account is already pinned' };
    }

    // Insert the account
    const { rows } = await client.query(
      `INSERT INTO hl_pinned_accounts (address, is_custom)
       VALUES ($1, true)
       RETURNING id, address, is_custom, pinned_at`,
      [normalizedAddress]
    );

    await client.query('COMMIT');

    return {
      success: true,
      account: {
        id: Number(rows[0].id),
        address: String(rows[0].address),
        isCustom: Boolean(rows[0].is_custom),
        pinnedAt: String(rows[0].pinned_at),
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[persist] addCustomPinnedAccount failed:', e);
    return { success: false, error: 'Failed to add custom account' };
  } finally {
    client.release();
  }
}

/**
 * Unpin an account by address
 * @returns true if removed, false if not found
 */
export async function unpinAccount(address: string): Promise<boolean> {
  try {
    const p = await getPool();
    const { rowCount } = await p.query(
      'DELETE FROM hl_pinned_accounts WHERE lower(address) = $1',
      [address.toLowerCase()]
    );
    return (rowCount ?? 0) > 0;
  } catch (e) {
    console.error('[persist] unpinAccount failed:', e);
    return false;
  }
}

/**
 * Get count of pinned accounts
 * @param isCustom - Optional filter: true for custom only, false for leaderboard-pinned only
 */
export async function getPinnedAccountCount(isCustom?: boolean): Promise<number> {
  try {
    const p = await getPool();
    let sql = 'SELECT COUNT(*) as cnt FROM hl_pinned_accounts';
    const params: boolean[] = [];
    if (isCustom !== undefined) {
      sql += ' WHERE is_custom = $1';
      params.push(isCustom);
    }
    const { rows } = await p.query(sql, params);
    return Number(rows[0]?.cnt ?? 0);
  } catch (_e) {
    return 0;
  }
}

/**
 * Check if an address is pinned
 * @returns Object with isPinned and isCustom flags, or null if not pinned
 */
export async function isPinnedAccount(address: string): Promise<{ isPinned: boolean; isCustom: boolean } | null> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      'SELECT is_custom FROM hl_pinned_accounts WHERE lower(address) = $1 LIMIT 1',
      [address.toLowerCase()]
    );
    if (rows.length === 0) return null;
    return { isPinned: true, isCustom: Boolean(rows[0].is_custom) };
  } catch (_e) {
    return null;
  }
}

/**
 * Get all pinned addresses as a Set (for efficient lookup)
 */
export async function getPinnedAddressSet(): Promise<Set<string>> {
  try {
    const p = await getPool();
    const { rows } = await p.query('SELECT address FROM hl_pinned_accounts');
    return new Set(rows.map((row: Record<string, unknown>) => String(row.address).toLowerCase()));
  } catch (_e) {
    return new Set();
  }
}

// =====================
// Legacy Custom Accounts (for backward compatibility during migration)
// =====================

const MAX_CUSTOM_ACCOUNTS = 3;

export interface CustomAccount {
  id: number;
  address: string;
  nickname: string | null;
  addedAt: string;
}

/**
 * @deprecated Use listPinnedAccounts instead
 * Get all custom accounts (max 3)
 */
export async function listCustomAccounts(): Promise<CustomAccount[]> {
  try {
    const p = await getPool();
    // Try new table first, fall back to old table
    const { rows } = await p.query(
      `SELECT id, address, pinned_at as added_at FROM hl_pinned_accounts WHERE is_custom = true ORDER BY pinned_at ASC`
    ).catch(async () => {
      // Fallback to old table
      return p.query(
        `SELECT id, address, nickname, added_at FROM hl_custom_accounts ORDER BY added_at ASC`
      );
    });
    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      address: String(row.address),
      nickname: row.nickname ? String(row.nickname) : null,
      addedAt: String(row.added_at),
    }));
  } catch (e) {
    console.error('[persist] listCustomAccounts failed:', e);
    return [];
  }
}

/**
 * @deprecated Use addCustomPinnedAccount instead
 * Add a custom account (max 3 allowed)
 */
export async function addCustomAccount(
  address: string,
  nickname?: string | null
): Promise<{ success: boolean; account?: CustomAccount; error?: string }> {
  // Delegate to new function
  const result = await addCustomPinnedAccount(address);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    account: {
      id: result.account!.id,
      address: result.account!.address,
      nickname: nickname || null,
      addedAt: result.account!.pinnedAt,
    },
  };
}

/**
 * @deprecated Use unpinAccount instead
 * Remove a custom account by address
 */
export async function removeCustomAccount(address: string): Promise<boolean> {
  return unpinAccount(address);
}

/**
 * @deprecated Use getPinnedAccountCount(true) instead
 * Get count of custom accounts
 */
export async function getCustomAccountCount(): Promise<number> {
  return getPinnedAccountCount(true);
}

/**
 * @deprecated Use isPinnedAccount instead
 * Check if an address is a custom account
 */
export async function isCustomAccount(address: string): Promise<boolean> {
  const result = await isPinnedAccount(address);
  return result?.isCustom === true;
}

/**
 * @deprecated Nicknames are now managed via leaderboard_entries
 * Update nickname for a custom account
 */
export async function updateCustomAccountNickname(
  address: string,
  nickname: string | null
): Promise<{ success: boolean; account?: CustomAccount; error?: string }> {
  try {
    const p = await getPool();
    // Update nickname in leaderboard_entries if it exists
    await p.query(
      `UPDATE hl_leaderboard_entries
       SET remark = $2
       WHERE lower(address) = $1`,
      [address.toLowerCase(), nickname || null]
    );

    // Check if the account is pinned
    const pinned = await isPinnedAccount(address);
    if (!pinned) {
      return { success: false, error: 'Account not found' };
    }

    return {
      success: true,
      account: {
        id: 0,
        address: address.toLowerCase(),
        nickname: nickname,
        addedAt: new Date().toISOString(),
      },
    };
  } catch (e) {
    console.error('[persist] updateCustomAccountNickname failed:', e);
    return { success: false, error: 'Failed to update nickname' };
  }
}

// =====================
// Leaderboard Refresh Timestamp
// =====================

/**
 * Get the last refresh timestamp for a period
 */
export async function getLastRefreshTime(period: number): Promise<string | null> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `SELECT MAX(fetched_at) as last_refresh
       FROM hl_leaderboard_entries
       WHERE period_days = $1`,
      [period]
    );
    return rows[0]?.last_refresh ? String(rows[0].last_refresh) : null;
  } catch (_e) {
    return null;
  }
}

// =====================
// Fills Backfill
// =====================

export interface BackfillFill {
  id: number;
  time_utc: string;
  address: string;
  symbol: string;
  action: string;
  size_signed: number | null;
  previous_position: number | null;
  price_usd: number | null;
  closed_pnl_usd: number | null;
  tx_hash: string | null;
}

/**
 * Get fills for backfill, filtered to BTC/ETH only
 * @param beforeTime ISO timestamp to fetch fills before
 * @param limit Maximum number of fills to return
 * @param addresses Optional array of addresses to filter by
 */
export async function getBackfillFills(opts: {
  beforeTime?: string | null;
  limit?: number;
  addresses?: string[];
}): Promise<{ fills: BackfillFill[]; hasMore: boolean; oldestTime: string | null }> {
  const safeLimit = Math.max(1, Math.min(100, opts.limit ?? 50));
  try {
    const p = await getPool();
    const params: (string | number | string[])[] = [];
    const clauses: string[] = [
      "type = 'trade'",
      "(payload->>'symbol' IN ('BTC', 'ETH') OR (payload->>'symbol' IS NULL))" // Include BTC/ETH or legacy null symbol (assumed BTC)
    ];
    let idx = 1;

    if (opts.addresses && opts.addresses.length > 0) {
      clauses.push(`address = ANY($${idx++})`);
      params.push(opts.addresses.map(a => a.toLowerCase()));
    }

    if (opts.beforeTime) {
      clauses.push(`COALESCE((payload->>'at')::timestamptz, at) < $${idx++}`);
      params.push(opts.beforeTime);
    }

    params.push(safeLimit + 1); // Fetch one extra to check hasMore

    const sql = `
      SELECT
        id,
        COALESCE((payload->>'at')::timestamptz, at) AS time_utc,
        address,
        COALESCE(payload->>'symbol', 'BTC') AS symbol,
        payload->>'action' AS action,
        CASE payload->>'action'
          WHEN 'Increase Long'  THEN (payload->>'size')::numeric
          WHEN 'Decrease Short' THEN (payload->>'size')::numeric
          WHEN 'Close Short'    THEN (payload->>'size')::numeric
          WHEN 'Decrease Long'  THEN -(payload->>'size')::numeric
          WHEN 'Close Long'     THEN -(payload->>'size')::numeric
          WHEN 'Increase Short' THEN -(payload->>'size')::numeric
          ELSE (payload->>'size')::numeric
        END AS size_signed,
        (payload->>'startPosition')::numeric AS previous_position,
        -- Calculate resulting_position = startPosition + position_delta
        -- startPosition is already signed (negative for shorts)
        -- For longs: buy adds to position, sell subtracts
        -- For shorts: buy (cover) makes less negative, sell makes more negative
        (payload->>'startPosition')::numeric +
        CASE payload->>'action'
          WHEN 'Increase Long'  THEN (payload->>'size')::numeric   -- buy adds
          WHEN 'Open Long'      THEN (payload->>'size')::numeric   -- buy adds
          WHEN 'Decrease Long'  THEN -(payload->>'size')::numeric  -- sell subtracts
          WHEN 'Close Long'     THEN -(payload->>'size')::numeric  -- sell subtracts
          WHEN 'Increase Short' THEN -(payload->>'size')::numeric  -- sell makes more negative
          WHEN 'Open Short'     THEN -(payload->>'size')::numeric  -- sell makes negative
          WHEN 'Decrease Short' THEN (payload->>'size')::numeric   -- buy makes less negative
          WHEN 'Close Short'    THEN (payload->>'size')::numeric   -- buy closes to 0
          ELSE (payload->>'size')::numeric
        END AS resulting_position,
        (payload->>'priceUsd')::numeric AS price_usd,
        (payload->>'realizedPnlUsd')::numeric AS closed_pnl_usd,
        payload->>'hash' AS tx_hash
      FROM hl_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY time_utc DESC, id DESC
      LIMIT $${idx}
    `;

    const { rows } = await p.query(sql, params);

    const hasMore = rows.length > safeLimit;
    const fills = rows.slice(0, safeLimit).map((row: Record<string, unknown>) => {
      // PostgreSQL returns timestamps as Date objects - convert to ISO string
      const timeValue = row.time_utc;
      const timeUtc = timeValue instanceof Date
        ? timeValue.toISOString()
        : String(timeValue);
      return {
        id: Number(row.id),
        time_utc: timeUtc,
        address: String(row.address),
        symbol: String(row.symbol || 'BTC'),
        action: String(row.action || ''),
        size_signed: row.size_signed != null ? Number(row.size_signed) : null,
        previous_position: row.previous_position != null ? Number(row.previous_position) : null,
        resulting_position: row.resulting_position != null ? Number(row.resulting_position) : null,
        price_usd: row.price_usd != null ? Number(row.price_usd) : null,
        closed_pnl_usd: row.closed_pnl_usd != null ? Number(row.closed_pnl_usd) : null,
        tx_hash: row.tx_hash ? String(row.tx_hash) : null,
      };
    });

    const oldestTime = fills.length > 0 ? fills[fills.length - 1].time_utc : null;

    return { fills, hasMore, oldestTime };
  } catch (e) {
    console.error('[persist] getBackfillFills failed:', e);
    return { fills: [], hasMore: false, oldestTime: null };
  }
}

/**
 * Deletes all trade events for a given address and symbol.
 * Used for data repair when position chain is corrupted.
 */
export async function clearTradesForAddress(
  address: string,
  symbol?: 'BTC' | 'ETH'
): Promise<number> {
  try {
    const p = await getPool();
    let sql = `DELETE FROM hl_events WHERE type = 'trade' AND LOWER(address) = LOWER($1)`;
    const params: (string | undefined)[] = [address];

    if (symbol) {
      sql += ` AND COALESCE(payload->>'symbol', 'BTC') = $2`;
      params.push(symbol);
    }

    const result = await p.query(sql, params);
    return result.rowCount ?? 0;
  } catch (e) {
    console.error('[persist] clearTradesForAddress failed:', e);
    return 0;
  }
}

/**
 * Validates position chain integrity for a given address and symbol.
 * Checks if each fill's resulting_position matches the next fill's previous_position.
 * Returns gaps where data is missing or corrupted.
 */
export async function validatePositionChain(
  address: string,
  symbol: 'BTC' | 'ETH' = 'ETH'
): Promise<{ valid: boolean; gaps: Array<{ time: string; expected: number; actual: number }> }> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      `
      SELECT
        COALESCE((payload->>'at')::timestamptz, at) AS time_utc,
        (payload->>'startPosition')::numeric AS previous_position,
        (payload->>'startPosition')::numeric +
        CASE payload->>'action'
          WHEN 'Increase Long'  THEN (payload->>'size')::numeric
          WHEN 'Open Long'      THEN (payload->>'size')::numeric
          WHEN 'Decrease Long'  THEN -(payload->>'size')::numeric
          WHEN 'Close Long'     THEN -(payload->>'size')::numeric
          WHEN 'Increase Short' THEN -(payload->>'size')::numeric
          WHEN 'Open Short'     THEN -(payload->>'size')::numeric
          WHEN 'Decrease Short' THEN (payload->>'size')::numeric
          WHEN 'Close Short'    THEN (payload->>'size')::numeric
          ELSE (payload->>'size')::numeric
        END AS resulting_position
      FROM hl_events
      WHERE type = 'trade'
        AND LOWER(address) = LOWER($1)
        AND COALESCE(payload->>'symbol', 'BTC') = $2
      ORDER BY time_utc DESC
      `,
      [address, symbol]
    );

    const gaps: Array<{ time: string; expected: number; actual: number }> = [];

    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i];
      const next = rows[i + 1];

      const currentPrev = Number(current.previous_position);
      const nextResult = Number(next.resulting_position);

      // Allow small floating point differences (0.0001)
      if (Math.abs(currentPrev - nextResult) > 0.0001) {
        gaps.push({
          time: current.time_utc,
          expected: nextResult,
          actual: currentPrev,
        });
      }
    }

    return { valid: gaps.length === 0, gaps };
  } catch (e) {
    console.error('[persist] validatePositionChain failed:', e);
    return { valid: false, gaps: [] };
  }
}

/**
 * Get the oldest fill time we have in DB for given addresses
 */
export async function getOldestFillTime(addresses?: string[]): Promise<string | null> {
  try {
    const p = await getPool();
    let sql = `
      SELECT MIN(COALESCE((payload->>'at')::timestamptz, at)) AS oldest
      FROM hl_events
      WHERE type = 'trade'
        AND (payload->>'symbol' IN ('BTC', 'ETH') OR payload->>'symbol' IS NULL)
    `;
    const params: string[][] = [];

    if (addresses && addresses.length > 0) {
      sql += ' AND address = ANY($1)';
      params.push(addresses.map(a => a.toLowerCase()));
    }

    const { rows } = await p.query(sql, params);
    return rows[0]?.oldest ? String(rows[0].oldest) : null;
  } catch (_e) {
    return null;
  }
}
