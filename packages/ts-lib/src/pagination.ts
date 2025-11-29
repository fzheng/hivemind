/**
 * Trade Pagination Module
 *
 * Provides utilities for merging and paginating trade records from
 * multiple sources (database, API backfill). Handles deduplication
 * and chronological sorting.
 *
 * @module pagination
 */

/**
 * Represents a single trade record for pagination.
 * Can come from database or API backfill.
 */
export type TradeRow = {
  /** Database ID if persisted */
  id?: number;
  /** ISO timestamp of the trade */
  time: string;
  /** Ethereum address (lowercase) */
  address: string;
  /** Human-readable action label (e.g., "Open Long") */
  action: string;
  /** Trade size in coin units */
  size: number;
  /** Position size before this trade */
  startPosition: number;
  /** Execution price in USD */
  price: number;
  /** Realized PnL if closing position, null otherwise */
  closedPnl: number | null;
  /** Transaction hash (legacy field) */
  tx?: string | null;
  /** Transaction hash (preferred field) */
  hash?: string | null;
};

/**
 * State object for rate limiting operations.
 */
export type RateState = {
  /** Timestamp of last operation in milliseconds */
  lastAt: number;
};

/**
 * Converts a trade row's time to a timestamp for sorting.
 * @param t - Trade row
 * @returns Milliseconds timestamp, or 0 if invalid
 */
const toTs = (t: TradeRow): number => {
  const ts = Date.parse(t.time);
  return Number.isFinite(ts) ? ts : 0;
};

/**
 * Generates a unique key for a trade to enable deduplication.
 * Prefers transaction hash, falls back to ID+time or address+time.
 *
 * @param t - Trade row
 * @returns Unique string key for the trade
 */
function tradeKey(t: TradeRow): string {
  if (t.tx) return `tx:${t.tx}`;
  if (t.hash) return `hash:${t.hash}`;
  if (t.id != null && t.time) return `idtime:${t.id}:${t.time}`;
  if (t.time && t.address) return `addrtime:${t.address}:${t.time}`;
  if (t.id != null) return `id:${t.id}`;
  return `fallback:${t.address ?? ''}:${t.time ?? ''}`;
}

/**
 * Comparator for sorting trades newest-first.
 * Ties are broken by database ID (higher ID = newer).
 *
 * @param a - First trade
 * @param b - Second trade
 * @returns Negative if a is newer, positive if b is newer
 */
const tradeSort = (a: TradeRow, b: TradeRow): number => {
  const ta = toTs(a);
  const tb = toTs(b);
  if (ta !== tb) return tb - ta; // newest first
  const ida = a.id ?? 0;
  const idb = b.id ?? 0;
  return idb - ida;
};

/**
 * Merges two arrays of trades, deduplicating by unique key.
 * Existing entries in `base` take precedence over `incoming`.
 * Result is sorted newest-first.
 *
 * @param base - Existing trades (higher priority)
 * @param incoming - New trades to merge in
 * @returns Merged and sorted array of unique trades
 *
 * @example
 * ```typescript
 * const existing = [{ hash: 'abc', ... }];
 * const newTrades = [{ hash: 'abc', ... }, { hash: 'xyz', ... }];
 * const merged = mergeTrades(existing, newTrades);
 * // merged contains 'abc' from existing and 'xyz' from newTrades
 * ```
 */
export function mergeTrades(base: TradeRow[], incoming: TradeRow[]): TradeRow[] {
  const result = [...base];
  const seen = new Set(result.map((t) => tradeKey(t)));
  for (const t of incoming) {
    const key = tradeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result.sort(tradeSort);
}

/**
 * Simple rate limiter for controlling request frequency.
 * Returns true if enough time has passed since the last successful call.
 * Automatically updates the state timestamp when returning true.
 *
 * @param state - Mutable state object tracking last call time
 * @param minIntervalMs - Minimum milliseconds between allowed calls
 * @returns true if the operation should proceed, false if rate limited
 *
 * @example
 * ```typescript
 * const state = { lastAt: 0 };
 * canLoadMore(state, 1000) // true, updates state.lastAt
 * canLoadMore(state, 1000) // false (called too soon)
 * // ... wait 1 second ...
 * canLoadMore(state, 1000) // true again
 * ```
 */
export function canLoadMore(state: RateState, minIntervalMs: number): boolean {
  const now = Date.now();
  if (!state.lastAt || now - state.lastAt >= minIntervalMs) {
    state.lastAt = now;
    return true;
  }
  return false;
}
