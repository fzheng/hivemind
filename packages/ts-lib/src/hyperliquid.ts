import * as hl from '@nktkas/hyperliquid';
import { clearinghouseState, userFills } from '@nktkas/hyperliquid/api/info';
import type { PositionInfo } from './types';

// Reuse a single HTTP transport for SDK calls
const transport = new hl.HttpTransport();

// Internal helpers
function isBtcCoin(coin: unknown): boolean {
  return typeof coin === 'string' && /^btc$/i.test(coin);
}

function toUser(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

/**
 * Returns net BTC perp exposure (signed size in coin units).
 * Falls back to 0 on API errors to keep callers resilient.
 */
export async function fetchBtcPerpExposure(address: string): Promise<number> {
  try {
    const data = await clearinghouseState(
      { transport },
      { user: toUser(address) }
    );
    const positions = data?.assetPositions ?? [];
    let netBtc = 0;
    for (const assetPosition of positions) {
      const pos = assetPosition?.position;
      const coin = pos?.coin ?? '';
      const size = Number(pos?.szi ?? 0);
      if (isBtcCoin(coin) && Number.isFinite(size)) netBtc += size;
    }
    return netBtc;
  } catch {
    return 0;
  }
}

/**
 * Returns all non-flat perp positions for a user from the info API.
 * BTC is included here (for completeness) and symbol is uppercased.
 */
export async function fetchPerpPositions(address: string): Promise<PositionInfo[]> {
  try {
    const data = await clearinghouseState(
      { transport },
      { user: toUser(address) }
    );
    const out: PositionInfo[] = [];
    for (const assetPosition of data?.assetPositions ?? []) {
      const pos = assetPosition?.position;
      const coin = pos?.coin ?? '';
      const size = Number(pos?.szi ?? 0);
      if (!Number.isFinite(size) || size === 0) continue;
      const entry = Number(pos?.entryPx ?? NaN);
      const levValue = Number(pos?.leverage?.value ?? NaN);
      out.push({
        symbol: String(coin).toUpperCase(),
        size,
        entryPriceUsd: Number.isFinite(entry) ? entry : undefined,
        leverage: Number.isFinite(levValue) ? levValue : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface UserFill {
  coin: string;
  px: number;
  sz: number;
  side: 'B' | 'A';
  time: number; // ms epoch
  startPosition: number;
  closedPnl?: number;
  fee?: number;
  feeToken?: string;
  hash?: string;
}

/**
 * Fetches recent user fills and returns only BTC fills, newest first.
 * Values are normalized to numbers and optional fields omitted if invalid.
 */
export async function fetchUserBtcFills(
  address: string,
  opts?: { aggregateByTime?: boolean }
): Promise<UserFill[]> {
  try {
    const fills = await userFills(
      { transport },
      { user: toUser(address), aggregateByTime: opts?.aggregateByTime },
    );
    const out: UserFill[] = [];
    for (const f of fills || []) {
      if (!isBtcCoin((f as any)?.coin)) continue;
      const px = Number((f as any)?.px);
      const sz = Number((f as any)?.sz);
      const time = Number((f as any)?.time);
      const start = Number((f as any)?.startPosition);
      const closedRaw = (f as any)?.closedPnl;
      const feeRaw = (f as any)?.fee;
      const feeToken = typeof (f as any)?.feeToken === 'string' ? String((f as any).feeToken) : undefined;
      const hash = typeof (f as any)?.hash === 'string' ? String((f as any).hash) : undefined;
      const side = ((f as any)?.side === 'B' ? 'B' : 'A') as 'B' | 'A';

      if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(time) || !Number.isFinite(start)) continue;

      const closed = Number.isFinite(Number(closedRaw)) ? Number(closedRaw) : undefined;
      const fee = Number.isFinite(Number(feeRaw)) ? Number(feeRaw) : undefined;

      out.push({
        coin: 'BTC',
        px,
        sz,
        side,
        time,
        startPosition: start,
        closedPnl: closed,
        fee,
        feeToken,
        hash,
      });
    }
    return out.sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}
