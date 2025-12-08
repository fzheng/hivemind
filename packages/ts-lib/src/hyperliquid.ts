import * as hl from '@nktkas/hyperliquid';
import { clearinghouseState, userFills, userDetails, metaAndAssetCtxs } from '@nktkas/hyperliquid/api/info';
import type { PositionInfo } from './types';

// Reuse a single HTTP transport for SDK calls
const transport = new hl.HttpTransport();

/**
 * Token bucket rate limiter for Hyperliquid API calls.
 *
 * Hyperliquid limits: 1200 weight/minute per IP
 * - clearinghouseState: weight 2
 * - userFills: weight 20 (paginated, +1 per 20 items)
 * - userDetails: weight 20
 * - metaAndAssetCtxs: weight 2
 *
 * Default: 2 calls/second = 120 calls/minute (safe margin for mixed weights)
 */
class RateLimiter {
  private lastCallTime = 0;
  private readonly minIntervalMs: number;

  constructor(callsPerSecond = 2.0) {
    this.minIntervalMs = 1000 / callsPerSecond;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallTime = Date.now();
  }
}

/** Global rate limiter for all Hyperliquid SDK calls */
const hlRateLimiter = new RateLimiter(
  Number(process.env.HL_SDK_CALLS_PER_SECOND ?? 2.0)
);

/** Max retries on rate limit (429) errors */
const MAX_RETRIES = Number(process.env.HL_SDK_MAX_RETRIES ?? 3);

/** Base backoff delay in ms for exponential backoff */
const BACKOFF_BASE_MS = Number(process.env.HL_SDK_BACKOFF_BASE_MS ?? 1000);

/**
 * Execute an SDK call with rate limiting and retry logic.
 * Handles 429 errors with exponential backoff.
 */
async function withRateLimitAndRetry<T>(
  fn: () => Promise<T>,
  fallback: T,
  operationName: string
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await hlRateLimiter.acquire();
      return await fn();
    } catch (err: unknown) {
      const is429 = err instanceof Error && (
        err.message.includes('429') ||
        err.message.toLowerCase().includes('rate') ||
        err.message.toLowerCase().includes('too many')
      );

      if (is429 && attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.warn(`[hyperliquid] Rate limited on ${operationName}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // Non-rate-limit error or exhausted retries
      if (attempt === MAX_RETRIES && is429) {
        console.error(`[hyperliquid] Rate limit retries exhausted for ${operationName}`);
      }
      return fallback;
    }
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Internal helpers
function isBtcCoin(coin: unknown): boolean {
  return typeof coin === 'string' && /^btc$/i.test(coin);
}

function isEthCoin(coin: unknown): boolean {
  return typeof coin === 'string' && /^eth$/i.test(coin);
}

function isBtcOrEthCoin(coin: unknown): boolean {
  return isBtcCoin(coin) || isEthCoin(coin);
}

function toUser(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

/**
 * Returns net BTC perp exposure (signed size in coin units).
 * Falls back to 0 on API errors to keep callers resilient.
 * Rate limited with retry on 429.
 */
export async function fetchBtcPerpExposure(address: string): Promise<number> {
  return withRateLimitAndRetry(
    async () => {
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
    },
    0,
    'fetchBtcPerpExposure'
  );
}

/**
 * Returns all non-flat perp positions for a user from the info API.
 * BTC is included here (for completeness) and symbol is uppercased.
 * Rate limited with retry on 429.
 */
export async function fetchPerpPositions(address: string): Promise<PositionInfo[]> {
  return withRateLimitAndRetry(
    async () => {
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
    },
    [],
    'fetchPerpPositions'
  );
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
 * Fetches recent user fills for BTC and ETH, newest first.
 * Values are normalized to numbers and optional fields omitted if invalid.
 * Rate limited with retry on 429.
 */
export async function fetchUserFills(
  address: string,
  opts?: { aggregateByTime?: boolean; symbols?: ('BTC' | 'ETH')[] }
): Promise<UserFill[]> {
  const symbols = opts?.symbols ?? ['BTC', 'ETH'];
  return withRateLimitAndRetry(
    async () => {
      const fills = await userFills(
        { transport },
        { user: toUser(address), aggregateByTime: opts?.aggregateByTime },
      );
      const out: UserFill[] = [];
      for (const f of fills || []) {
        const coin = (f as any)?.coin;
        if (!isBtcOrEthCoin(coin)) continue;
        const coinUpper = String(coin).toUpperCase();
        if (!symbols.includes(coinUpper as 'BTC' | 'ETH')) continue;

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
          coin: coinUpper,
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
    },
    [],
    'fetchUserFills'
  );
}

export interface UserProfileSummary {
  txCount: number;
  lastTxTime: string | null;
}

/**
 * Fetches user profile summary including transaction count.
 * Rate limited with retry on 429.
 */
export async function fetchUserProfile(address: string): Promise<UserProfileSummary> {
  return withRateLimitAndRetry(
    async () => {
      const data = await userDetails(
        { transport },
        { user: toUser(address) }
      );
      const txs = data?.txs ?? [];
      const last = txs[0];
      return {
        txCount: txs.length,
        lastTxTime: last?.time ? new Date(Number(last.time)).toISOString() : null
      };
    },
    { txCount: 0, lastTxTime: null },
    'fetchUserProfile'
  );
}

export async function fetchSpotPrice(symbol: 'BTCUSDT' | 'ETHUSDT'): Promise<number> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ticker HTTP ${res.status}`);
  const data = (await res.json()) as { price?: string };
  const price = Number(data.price);
  if (!Number.isFinite(price)) throw new Error('Invalid ticker price');
  return price;
}

type MarkCache = {
  ts: number;
  prices: Record<string, number>;
};

let markCache: MarkCache | null = null;

/**
 * Load mark prices for all assets from Hyperliquid.
 * Rate limited with retry on 429.
 */
async function loadMetaMarks(): Promise<MarkCache> {
  return withRateLimitAndRetry(
    async () => {
      const [meta, ctxs] = await metaAndAssetCtxs({ transport });
      const prices: Record<string, number> = {};
      (meta?.universe || []).forEach((asset: any, idx: number) => {
        const name = String(asset?.name || '').toUpperCase();
        const ctx = ctxs?.[idx];
        const mark = Number(ctx?.markPx ?? ctx?.markPx ?? ctx?.midPx);
        if (Number.isFinite(mark)) prices[name] = mark;
      });
      const cache = { ts: Date.now(), prices };
      markCache = cache;
      return cache;
    },
    markCache ?? { ts: 0, prices: {} },
    'loadMetaMarks'
  );
}

export async function fetchPerpMarkPrice(symbol: 'BTC' | 'ETH'): Promise<number> {
  const now = Date.now();
  if (!markCache || now - markCache.ts > 1500) {
    await loadMetaMarks();
  }
  const price = markCache?.prices?.[symbol.toUpperCase()];
  if (price == null) {
    await loadMetaMarks();
    return markCache?.prices?.[symbol.toUpperCase()] ?? 0;
  }
  return price;
}
