import { fetchWithRetry } from './utils';
import type { PriceInfo } from './types';

// BTC price state
let currentBtcPrice: number | null = null;
let btcUpdatedAt: string | null = null;
let btcPriceSource: 'ws' | 'http' | 'unknown' = 'unknown';

// ETH price state
let currentEthPrice: number | null = null;
let ethUpdatedAt: string | null = null;
let ethPriceSource: 'ws' | 'http' | 'unknown' = 'unknown';

// Legacy alias for backward compatibility
let currentPrice: number | null = null;
let updatedAt: string | null = null;
let priceSource: 'ws' | 'http' | 'unknown' = 'unknown';

let wsTransport: any = null;
let wsSub: any | null = null;
let activeUser: string | null = null;
let provider: (() => Promise<string[]>) | null = null;

// Price change listeners for real-time updates
type PriceChangeListener = (prices: { btc: number | null; eth: number | null }) => void;
const priceChangeListeners: Set<PriceChangeListener> = new Set();

export function onPriceChange(listener: PriceChangeListener): () => void {
  priceChangeListeners.add(listener);
  return () => priceChangeListeners.delete(listener);
}

function notifyPriceChange() {
  const prices = { btc: currentBtcPrice, eth: currentEthPrice };
  for (const listener of priceChangeListeners) {
    try {
      listener(prices);
    } catch {}
  }
}

function setBtcPrice(p: number, source: 'ws' | 'http') {
  if (Number.isFinite(p)) {
    currentBtcPrice = p;
    btcUpdatedAt = new Date().toISOString();
    btcPriceSource = source;
    // Legacy compatibility
    currentPrice = p;
    updatedAt = btcUpdatedAt;
    priceSource = source;
    notifyPriceChange();
  }
}

function setEthPrice(p: number, source: 'ws' | 'http') {
  if (Number.isFinite(p)) {
    currentEthPrice = p;
    ethUpdatedAt = new Date().toISOString();
    ethPriceSource = source;
    notifyPriceChange();
  }
}

// Legacy function for backward compatibility
function setPrice(p: number, source: 'ws' | 'http') {
  setBtcPrice(p, source);
}

type SubscribeFn = (user: string, listener: (evt: any) => void) => Promise<{ unsubscribe?: () => Promise<void> } | null>;

async function defaultSubscribeWebData2(user: string, listener: (evt: any) => void) {
  const hl = await import('@nktkas/hyperliquid');
  const { webData2 } = await import('@nktkas/hyperliquid/api/subscription');
  const WS = (await import('ws')).default as any;
  if (!wsTransport) {
    wsTransport = new (hl as any).WebSocketTransport({ reconnect: { WebSocket: WS } });
  }
  return (webData2 as any)({ transport: wsTransport }, { user: user as `0x${string}` }, listener);
}

let subscribeWebData2Impl: SubscribeFn = defaultSubscribeWebData2;

async function startWs(user: string) {
  if (wsSub) {
    try { await wsSub.unsubscribe?.(); } catch {}
    wsSub = null;
  }
  activeUser = user;
  wsSub = await subscribeWebData2Impl(user, (evt) => {
    try {
      const meta = evt.meta; // MetaResponse
      const ctxs = evt.assetCtxs; // contexts array

      // Find BTC price
      const btcIdx = meta.universe.findIndex((u: any) => String(u?.name).toUpperCase() === 'BTC');
      if (btcIdx >= 0 && ctxs[btcIdx]?.markPx) {
        const px = Number(ctxs[btcIdx].markPx);
        if (Number.isFinite(px)) setBtcPrice(px, 'ws');
      }

      // Find ETH price
      const ethIdx = meta.universe.findIndex((u: any) => String(u?.name).toUpperCase() === 'ETH');
      if (ethIdx >= 0 && ctxs[ethIdx]?.markPx) {
        const px = Number(ctxs[ethIdx].markPx);
        if (Number.isFinite(px)) setEthPrice(px, 'ws');
      }
    } catch {}
  });
}

export async function startPriceFeed(getAddresses: () => Promise<string[]>) {
  provider = getAddresses;
  const addrs = await getAddresses();
  const first = addrs?.[0];
  if (first && first !== activeUser) {
    await startWs(first);
  }
}

export async function refreshPriceFeed() {
  if (!provider) return;
  const addrs = await provider();
  const first = addrs?.[0] ?? null;
  if (first && first !== activeUser) {
    await startWs(first);
  }
  if (!first && wsSub) {
    try { await wsSub.unsubscribe?.(); } catch {}
    wsSub = null;
    activeUser = null;
  }
}

export function getCurrentBtcPrice(): { symbol: string; price: number | null; updatedAt: string | null; source: string } {
  return { symbol: 'BTCUSD', price: currentBtcPrice, updatedAt: btcUpdatedAt, source: btcPriceSource };
}

export function getCurrentEthPrice(): { symbol: string; price: number | null; updatedAt: string | null; source: string } {
  return { symbol: 'ETHUSD', price: currentEthPrice, updatedAt: ethUpdatedAt, source: ethPriceSource };
}

export function getCurrentPrices(): {
  btc: { price: number | null; updatedAt: string | null };
  eth: { price: number | null; updatedAt: string | null };
} {
  return {
    btc: { price: currentBtcPrice, updatedAt: btcUpdatedAt },
    eth: { price: currentEthPrice, updatedAt: ethUpdatedAt },
  };
}

// Test-only hooks (no side effects in production)
export function __setSubscribeWebData2ForTest(fn: SubscribeFn) {
  subscribeWebData2Impl = fn;
}
export async function __resetPriceForTest() {
  currentBtcPrice = null;
  btcUpdatedAt = null;
  btcPriceSource = 'unknown';
  currentEthPrice = null;
  ethUpdatedAt = null;
  ethPriceSource = 'unknown';
  // Legacy
  currentPrice = null;
  updatedAt = null;
  priceSource = 'unknown';
  activeUser = null;
  provider = null;
  priceChangeListeners.clear();
  if (wsSub) {
    try { await wsSub.unsubscribe?.(); } catch {}
  }
  wsSub = null;
  wsTransport = null;
}

async function binance(): Promise<number> {
  const data = await fetchWithRetry<{ symbol: string; price: string }>(
    'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    { method: 'GET' },
    { retries: 1, baseDelayMs: 500 }
  );
  const price = Number(data.price);
  if (!Number.isFinite(price)) throw new Error('Invalid price from Binance');
  return price;
}

async function coinbase(): Promise<number> {
  const data = await fetchWithRetry<any>(
    'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    { method: 'GET' },
    { retries: 1, baseDelayMs: 500 }
  );
  const price = Number(data.price ?? data.last);
  if (!Number.isFinite(price)) throw new Error('Invalid price from Coinbase');
  return price;
}

async function coingecko(): Promise<number> {
  const data = await fetchWithRetry<any>(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { method: 'GET' },
    { retries: 1, baseDelayMs: 500 }
  );
  const price = Number(data?.bitcoin?.usd);
  if (!Number.isFinite(price)) throw new Error('Invalid price from CoinGecko');
  return price;
}

async function bitstamp(): Promise<number> {
  const data = await fetchWithRetry<any>(
    'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    { method: 'GET' },
    { retries: 1, baseDelayMs: 500 }
  );
  const price = Number(data?.last);
  if (!Number.isFinite(price)) throw new Error('Invalid price from Bitstamp');
  return price;
}

async function kraken(): Promise<number> {
  const data = await fetchWithRetry<any>(
    'https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD',
    { method: 'GET' },
    { retries: 1, baseDelayMs: 500 }
  );
  const result = data?.result ?? {};
  const key = Object.keys(result)[0];
  const priceStr = result?.[key]?.c?.[0];
  const price = Number(priceStr);
  if (!Number.isFinite(price)) throw new Error('Invalid price from Kraken');
  return price;
}

export async function fetchBtcPriceUsd(): Promise<PriceInfo> {
  // Prefer live WebSocket price if available
  if (currentPrice && Number.isFinite(currentPrice)) {
    return { symbol: 'BTCUSD', price: currentPrice };
  }
  const sources: Array<() => Promise<number>> = [binance, coinbase, coingecko, bitstamp, kraken];
  const errors: string[] = [];
  for (const s of sources) {
    try {
      const price = await s();
      setPrice(price, 'http');
      return { symbol: 'BTCUSD', price };
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
      continue;
    }
  }
  throw new Error('All price sources failed: ' + errors.join(' | '));
}
