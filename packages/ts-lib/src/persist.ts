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
  symbol: 'BTC';
  payload: any; // stored as JSON
};

export async function insertEvent(evt: InsertableEvent): Promise<number | null> {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      'insert into hl_events (at, address, type, symbol, payload) values ($1,$2,$3,$4,$5) returning id',
      [evt.at, evt.address, evt.type, evt.symbol, evt.payload]
    );
    return rows?.[0]?.id ?? null;
  } catch (_e) {
    return null;
  }
}

export async function upsertCurrentPosition(args: {
  address: string;
  symbol: 'BTC';
  size: number;
  entryPriceUsd: number | null;
  liquidationPriceUsd: number | null;
  leverage: number | null;
  pnlUsd: number | null;
  updatedAt?: string; // ISO
}): Promise<void> {
  try {
    const p = await getPool();
    await p.query(
      `insert into hl_current_positions(address, symbol, size, entry_price, liquidation_price, leverage, pnl, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict(address) do update set
         symbol=excluded.symbol,
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
  } catch (_e) {
    // ignore
  }
}

export async function latestTrades(limit = 50): Promise<any[]> {
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
export async function pageTradesByTime(opts: { limit?: number; beforeAt?: string | null; beforeId?: number | null; address?: string | null }): Promise<{ id: number; address: string; at: string; payload: any }[]> {
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
    const sql = `select id, address, at, payload from hl_events ${where} order by at desc, id desc limit ${limit}`;
    const { rows } = await p.query(sql, params);
    return rows as any[];
  } catch (_e) {
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

export async function insertTradeIfNew(address: string, payload: any): Promise<InsertTradeResult> {
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

export async function pageTrades(opts: { limit?: number; beforeId?: number | null; address?: string | null }): Promise<{ id: number; payload: any }[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  try {
    const p = await getPool();
    if (opts.address && opts.beforeId) {
      const { rows } = await p.query(
        'select id, payload from hl_events where type = $1 and address = $2 and id < $3 order by id desc limit $4',
        ['trade', opts.address.toLowerCase(), opts.beforeId, limit]
      );
      return rows as any[];
    } else if (opts.address) {
      const { rows } = await p.query(
        'select id, payload from hl_events where type = $1 and address = $2 order by id desc limit $3',
        ['trade', opts.address.toLowerCase(), limit]
      );
      return rows as any[];
    } else if (opts.beforeId) {
      const { rows } = await p.query(
        'select id, payload from hl_events where type = $1 and id < $2 order by id desc limit $3',
        ['trade', opts.beforeId, limit]
      );
      return rows as any[];
    } else {
      const { rows } = await p.query(
        'select id, payload from hl_events where type = $1 order by id desc limit $2',
        ['trade', limit]
      );
      return rows as any[];
    }
  } catch (_e) {
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
        order by at desc
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
