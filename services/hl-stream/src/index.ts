/**
 * HL-Stream Service
 *
 * Subscribes to Hyperliquid real-time WebSocket feeds for tracked addresses
 * and streams position and trade events to connected dashboard clients.
 * Also publishes fill events to NATS for downstream services.
 *
 * Key responsibilities:
 * - Maintain WebSocket connections to Hyperliquid for each tracked address
 * - Track position changes and trade fills in real-time
 * - Stream events to browser clients via WebSocket
 * - Publish fill events to `c.fills.v1` NATS topic
 * - Serve the dashboard UI and proxy API requests to hl-scout
 * - Handle historical fill backfill from Hyperliquid API
 *
 * @module hl-stream
 */

import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import swaggerUi from 'swagger-ui-express';
import type { OpenAPIV3 } from 'openapi-types';
import path from 'path';
import fs from 'fs';
import { setMaxListeners } from 'events';
import {
  EventQueue,
  RealtimeTracker,
  createHistogram,
  createLogger,
  getOwnerToken,
  getPort,
  initMetrics,
  metricsHandler,
  normalizeAddress,
  connectNats,
  ensureStream,
  publishJson,
  FillEventSchema,
  getBackfillFills,
  getOldestFillTime,
  fetchUserFills,
  insertTradeIfNew,
  getCurrentPrices,
  onPriceChange,
  startPriceFeed,
  refreshPriceFeed
} from '@hl/ts-lib';

const OWNER_TOKEN = getOwnerToken();
const logger = createLogger('hl-stream');
const metrics = initMetrics('hl_stream');
const fillsHistogram = createHistogram(metrics, 'fills_publish_seconds', 'Latency for publishing fills', [0.005, 0.01, 0.05, 0.1]);
const WATCH_PERIOD = Number(process.env.LEADERBOARD_PERIOD ?? process.env.LEADERBOARD_WATCH_PERIOD ?? 30);
const WATCH_LIMIT = Number(process.env.LEADERBOARD_SELECT_COUNT ?? 12);
setMaxListeners(0);

const swaggerDoc: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {
    title: 'hl-stream API',
    version: '0.1.0',
    description: 'Watchlist refresh, WebSocket feed access, and fake fill publisher.'
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      ownerToken: { type: 'apiKey', in: 'header', name: 'x-owner-key' }
    }
  },
  paths: {
    '/healthz': {
      get: { summary: 'Service health', responses: { 200: { description: 'OK' } } }
    },
    '/metrics': {
      get: { summary: 'Prometheus metrics', responses: { 200: { description: 'Prometheus text' } } }
    },
    '/watchlist': {
      get: { summary: 'Current watchlist', responses: { 200: { description: 'Addresses' } } }
    },
    '/watchlist/refresh': {
      post: {
        summary: 'Refresh watchlist from hl-scout',
        security: [{ ownerToken: [] }],
        responses: { 200: { description: 'Refreshed' } }
      }
    },
    '/ws': {
      get: {
        summary: 'WebSocket endpoint for realtime fills/positions',
        responses: { 101: { description: 'Switching to WebSocket' } }
      }
    }
  }
};

/** Event queue for streaming to WebSocket clients */
const queue = new EventQueue(5000);
/** Connected WebSocket clients */
const clients = new Set<{ ws: WebSocket; lastSeq: number; alive: boolean }>();
/** Currently tracked addresses */
let watchlist: string[] = [];
/** URL of hl-scout service for API proxying */
const scoutUrl = process.env.SCOUT_URL || 'http://hl-scout:8080';
/** Directory containing dashboard static files */
const dashboardDir = path.resolve(__dirname, '..', 'public');
/** NATS subject for fill events */
const fillsSubject = 'c.fills.v1';
/** Realtime tracker for Hyperliquid WebSocket subscriptions */
let tracker: RealtimeTracker | null = null;

/**
 * Express middleware for owner-only endpoints.
 * Requires x-owner-key header to match OWNER_TOKEN.
 */
function ownerOnly(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers['x-owner-key'] || req.headers['x-owner-token'] || '').toString();
  if (token !== OWNER_TOKEN) return res.status(403).json({ error: 'forbidden' });
  return next();
}

/**
 * Fetches the list of addresses to track from hl-scout.
 * Combines top-ranked system accounts with user's custom accounts.
 *
 * @returns Array of normalized Ethereum addresses
 */
async function fetchWatchlist(): Promise<string[]> {
  const addresses: string[] = [];

  // Fetch top-ranked system accounts from leaderboard
  const selectedUrl = new URL('/leaderboard/selected', scoutUrl);
  selectedUrl.searchParams.set('period', String(WATCH_PERIOD));
  selectedUrl.searchParams.set('limit', String(WATCH_LIMIT));
  try {
    const res = await fetch(selectedUrl, { headers: { 'x-owner-key': OWNER_TOKEN } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.entries) && data.entries.length) {
        addresses.push(...data.entries.map((entry: any) => normalizeAddress(entry.address)));
      }
    }
  } catch (err) {
    logger.warn('selected_watchlist_failed', { err: err instanceof Error ? err.message : err });
  }

  // Also fetch custom accounts and add them to the watchlist
  try {
    const customRes = await fetch(`${scoutUrl}/custom-accounts`, {
      headers: { 'x-owner-key': OWNER_TOKEN }
    });
    if (customRes.ok) {
      const customData = await customRes.json();
      if (Array.isArray(customData?.accounts) && customData.accounts.length) {
        const customAddresses = customData.accounts.map((acc: any) => normalizeAddress(acc.address));
        // Add custom addresses that aren't already in the list
        for (const addr of customAddresses) {
          if (!addresses.includes(addr)) {
            addresses.push(addr);
          }
        }
        logger.info('custom_accounts_added_to_watchlist', { count: customAddresses.length });
      }
    }
  } catch (err) {
    logger.warn('custom_accounts_watchlist_failed', { err: err instanceof Error ? err.message : err });
  }

  if (addresses.length) return addresses;

  // Fallback to addresses endpoint
  try {
    const fallback = await fetch(`${scoutUrl}/addresses`, {
      headers: { 'x-owner-key': OWNER_TOKEN }
    });
    if (fallback.ok) {
      const fallbackData = await fallback.json();
      return (fallbackData?.addresses || []).map((entry: any) => normalizeAddress(entry.address));
    }
  } catch (err) {
    logger.warn('addresses_watchlist_failed', { err: err instanceof Error ? err.message : err });
  }
  if (watchlist.length) return watchlist;
  return [];
}

/**
 * Proxies a request to the hl-scout service.
 * Used for dashboard API endpoints that need data from hl-scout.
 *
 * @param pathname - Path on hl-scout to request
 * @param req - Express request object
 * @param res - Express response object
 */
async function proxyScout(pathname: string, req: Request, res: Response) {
  try {
    const target = new URL(pathname, scoutUrl);
    const idx = req.originalUrl.indexOf('?');
    if (idx >= 0) {
      target.search = req.originalUrl.slice(idx);
    }
    const response = await fetch(target, { headers: { 'x-owner-key': OWNER_TOKEN } });
    const body = await response.text();
    const type = response.headers.get('content-type') || 'application/json';
    res.status(response.status).setHeader('Content-Type', type).send(body);
  } catch (err: any) {
    logger.error('dashboard_proxy_failed', { err: err?.message });
    res.status(502).json({ error: 'proxy_failed' });
  }
}

/**
 * Converts a trade event to a FillEvent schema for NATS publishing.
 *
 * @param evt - Raw trade event from RealtimeTracker
 * @returns Validated FillEvent payload
 */
function toFillEventPayload(evt: any) {
  return FillEventSchema.parse({
    fill_id: evt.hash || `${evt.address}-${evt.at}`,
    source: 'hyperliquid',
    address: evt.address,
    asset: evt.symbol || 'BTC',
    side: evt.side === 'sell' ? 'sell' : 'buy',
    size: Number(evt.size ?? evt.payload?.size ?? 0),
    price: Number(evt.priceUsd ?? evt.payload?.priceUsd ?? 0),
    start_position: typeof evt.startPosition === 'number' ? evt.startPosition : null,
    realized_pnl: evt.realizedPnlUsd != null ? Number(evt.realizedPnlUsd) : null,
    ts: evt.at,
    meta: { action: evt.action ?? null }
  });
}

/**
 * Publishes a fill event to NATS JetStream.
 * Called for each trade detected by the RealtimeTracker.
 *
 * @param js - JetStream client
 * @param evt - Trade event to publish
 */
async function publishFillFromEvent(
  js: Awaited<ReturnType<typeof connectNats>>['js'],
  evt: any
) {
  try {
    const fill = toFillEventPayload(evt);
    const end = (fillsHistogram as any).startTimer?.({ operation: 'publish' });
    await publishJson(js, fillsSubject, fill);
    end?.();
  } catch (err: any) {
    logger.warn('fill_publish_failed', { err: err?.message });
  }
}

/**
 * Configures WebSocket server for streaming events to clients.
 * Handles connection lifecycle, heartbeat, and event broadcasting.
 *
 * @param server - HTTP server to attach WebSocket server to
 */
function configureWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let pingInterval: NodeJS.Timeout | null = null;
  let broadcastInterval: NodeJS.Timeout | null = null;
  let priceInterval: NodeJS.Timeout | null = null;

  // Track last sent prices to only send on change
  let lastBtcPrice: number | null = null;
  let lastEthPrice: number | null = null;

  wss.on('connection', (ws) => {
    const client = { ws, lastSeq: 0, alive: true };
    clients.add(client);
    // Send initial hello with current prices
    const prices = getCurrentPrices();
    ws.send(JSON.stringify({
      type: 'hello',
      latestSeq: queue.latestSeq(),
      prices: { btc: prices.btc.price, eth: prices.eth.price }
    }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg && typeof msg.since === 'number') {
          client.lastSeq = msg.since;
          const events = queue.listSince(msg.since, 500);
          if (events.length) {
            client.lastSeq = events[events.length - 1].seq;
            ws.send(JSON.stringify({ type: 'batch', events }));
          }
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => { clients.delete(client); });
    ws.on('error', () => { clients.delete(client); });
  });

  pingInterval = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        clients.delete(client);
        try { client.ws.terminate(); } catch (e) {
          logger.warn('ws_terminate_failed', { error: e });
        }
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch (e) {
        logger.warn('ws_ping_failed', { error: e });
        clients.delete(client);
      }
    }
  }, 30000);

  const broadcast = () => {
    if (!clients.size) return;
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        continue;
      }
      const events = queue.listSince(client.lastSeq, 200);
      if (events.length) {
        client.lastSeq = events[events.length - 1].seq;
        try {
          client.ws.send(JSON.stringify({ type: 'events', events }));
        } catch (e) {
          logger.warn('ws_send_failed', { error: e });
          clients.delete(client);
        }
      }
    }
  };

  // Broadcast price updates to all clients
  const broadcastPrices = () => {
    if (!clients.size) return;
    const prices = getCurrentPrices();
    const btc = prices.btc.price;
    const eth = prices.eth.price;

    // Only broadcast if prices have changed
    if (btc === lastBtcPrice && eth === lastEthPrice) return;
    lastBtcPrice = btc;
    lastEthPrice = eth;

    const priceMsg = JSON.stringify({ type: 'price', btc, eth });
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        continue;
      }
      try {
        client.ws.send(priceMsg);
      } catch (e) {
        logger.warn('ws_price_send_failed', { error: e });
      }
    }
  };

  broadcastInterval = setInterval(broadcast, 1000);
  priceInterval = setInterval(broadcastPrices, 2000); // Broadcast prices every 2 seconds

  // Cleanup on server shutdown
  process.on('SIGTERM', () => {
    if (pingInterval) clearInterval(pingInterval);
    if (broadcastInterval) clearInterval(broadcastInterval);
    if (priceInterval) clearInterval(priceInterval);
    wss.close();
  });
}

/**
 * Main entry point for hl-stream service.
 * Initializes NATS, RealtimeTracker, Express server, and WebSocket.
 */
async function main() {
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  const nats = await connectNats(natsUrl);
  await ensureStream(nats.jsm, 'HL_C', [fillsSubject]);

  watchlist = await fetchWatchlist();
  logger.info('watchlist_loaded', { count: watchlist.length });

  tracker = new RealtimeTracker(async () => watchlist, queue, {
    onTrade: ({ event }) => {
      publishFillFromEvent(nats.js, event).catch((err) =>
        logger.error('fill_publish_failed', { err: err?.message })
      );
    }
  });

  // Start tracker and await position priming to ensure holdings are available immediately
  logger.info('starting_realtime_tracker', { watchlist: watchlist.length });
  await tracker.start({ awaitPositions: true });
  logger.info('realtime_tracker_ready', { watchlist: watchlist.length });

  // Start the price feed for real-time BTC/ETH prices
  startPriceFeed(async () => watchlist).catch((err) =>
    logger.warn('price_feed_start_failed', { err: err?.message })
  );

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));
  if (fs.existsSync(dashboardDir)) {
    app.use('/dashboard/static', express.static(dashboardDir));
    app.get('/dashboard', (_req, res) => {
      res.sendFile(path.join(dashboardDir, 'dashboard.html'));
    });
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', watchlist: watchlist.length }));
  app.get('/metrics', metricsHandler(metrics));
  app.get('/watchlist', (_req, res) => res.json({ addresses: watchlist }));
  app.get('/positions/status', (_req, res) => res.json({
    positionsReady: tracker?.positionsReady ?? false,
    watchlistCount: watchlist.length
  }));

  app.post('/watchlist/refresh', ownerOnly, async (_req, res) => {
    watchlist = await fetchWatchlist();
    await tracker?.refresh();
    logger.info('watchlist_refreshed', { count: watchlist.length });
    res.json({ ok: true, count: watchlist.length });
  });
  app.get('/dashboard/api/summary', (req, res) => proxyScout('/dashboard/summary', req, res));
  app.get('/dashboard/api/fills', (req, res) => proxyScout('/dashboard/fills', req, res));
  app.get('/dashboard/api/decisions', (req, res) => proxyScout('/dashboard/decisions', req, res));
  app.get('/dashboard/api/price', (req, res) => proxyScout('/dashboard/price', req, res));
  app.get('/dashboard/api/positions-status', (_req, res) => res.json({
    positionsReady: tracker?.positionsReady ?? false,
    watchlistCount: watchlist.length
  }));

  // Real-time prices endpoint
  app.get('/dashboard/api/prices', (_req, res) => {
    const prices = getCurrentPrices();
    res.json({
      btc: prices.btc.price,
      eth: prices.eth.price,
      btcUpdatedAt: prices.btc.updatedAt,
      ethUpdatedAt: prices.eth.updatedAt
    });
  });

  // Custom accounts proxy routes
  app.get('/dashboard/api/custom-accounts', (req, res) => proxyScout('/custom-accounts', req, res));
  app.post('/dashboard/api/custom-accounts', async (req, res) => {
    try {
      const target = new URL('/custom-accounts', scoutUrl);
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-owner-key': OWNER_TOKEN
        },
        body: JSON.stringify(req.body)
      });
      const body = await response.text();
      const type = response.headers.get('content-type') || 'application/json';
      res.status(response.status).setHeader('Content-Type', type).send(body);
    } catch (err: any) {
      logger.error('custom_accounts_proxy_failed', { err: err?.message });
      res.status(502).json({ error: 'proxy_failed' });
    }
  });
  app.delete('/dashboard/api/custom-accounts/:address', async (req, res) => {
    try {
      const target = new URL(`/custom-accounts/${encodeURIComponent(req.params.address)}`, scoutUrl);
      const response = await fetch(target, {
        method: 'DELETE',
        headers: { 'x-owner-key': OWNER_TOKEN }
      });
      const body = await response.text();
      const type = response.headers.get('content-type') || 'application/json';
      res.status(response.status).setHeader('Content-Type', type).send(body);
    } catch (err: any) {
      logger.error('custom_accounts_delete_proxy_failed', { err: err?.message });
      res.status(502).json({ error: 'proxy_failed' });
    }
  });
  app.patch('/dashboard/api/custom-accounts/:address', async (req, res) => {
    try {
      const target = new URL(`/custom-accounts/${encodeURIComponent(req.params.address)}`, scoutUrl);
      const response = await fetch(target, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-owner-key': OWNER_TOKEN
        },
        body: JSON.stringify(req.body)
      });
      const body = await response.text();
      const type = response.headers.get('content-type') || 'application/json';
      res.status(response.status).setHeader('Content-Type', type).send(body);
    } catch (err: any) {
      logger.error('custom_accounts_patch_proxy_failed', { err: err?.message });
      res.status(502).json({ error: 'proxy_failed' });
    }
  });

  // Leaderboard refresh proxy routes
  app.post('/dashboard/api/leaderboard/refresh', async (_req, res) => {
    try {
      const target = new URL('/leaderboard/refresh', scoutUrl);
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'x-owner-key': OWNER_TOKEN }
      });
      const body = await response.text();
      const type = response.headers.get('content-type') || 'application/json';

      // After leaderboard refresh succeeds, immediately refresh watchlist and positions
      // This ensures holdings are populated before the dashboard queries them
      if (response.ok && tracker) {
        try {
          watchlist = await fetchWatchlist();
          await tracker.refresh({ awaitPositions: true });
          await tracker.forceRefreshAllPositions();
          logger.info('watchlist_and_positions_synced_after_refresh', { count: watchlist.length });
        } catch (syncErr: any) {
          logger.warn('post_refresh_sync_failed', { err: syncErr?.message });
          // Don't fail the request, the leaderboard refresh itself succeeded
        }
      }

      res.status(response.status).setHeader('Content-Type', type).send(body);
    } catch (err: any) {
      logger.error('leaderboard_refresh_proxy_failed', { err: err?.message });
      res.status(502).json({ error: 'proxy_failed' });
    }
  });
  app.get('/dashboard/api/leaderboard/refresh-status', (req, res) => proxyScout('/leaderboard/refresh-status', req, res));

  // Backfill fills endpoint for infinite scroll
  app.get('/dashboard/api/fills/backfill', async (req, res) => {
    try {
      const beforeTime = req.query.before ? String(req.query.before) : null;
      const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10))) : 30;

      // Get current watchlist addresses for filtering
      const addresses = watchlist.length > 0 ? watchlist : undefined;

      const result = await getBackfillFills({
        beforeTime,
        limit,
        addresses
      });

      res.json({
        fills: result.fills,
        hasMore: result.hasMore,
        oldestTime: result.oldestTime
      });
    } catch (err: any) {
      logger.error('backfill_fills_failed', { err: err?.message });
      res.status(500).json({ error: 'Failed to fetch backfill fills' });
    }
  });

  // Get oldest fill time for the current watchlist
  app.get('/dashboard/api/fills/oldest', async (_req, res) => {
    try {
      const addresses = watchlist.length > 0 ? watchlist : undefined;
      const oldestTime = await getOldestFillTime(addresses);
      res.json({ oldestTime });
    } catch (err: any) {
      logger.error('oldest_fill_time_failed', { err: err?.message });
      res.status(500).json({ error: 'Failed to get oldest fill time' });
    }
  });

  // Fetch historical fills from Hyperliquid API and store in database
  app.post('/dashboard/api/fills/fetch-history', async (req, res) => {
    try {
      const limit = req.body?.limit ? Math.min(100, Math.max(1, parseInt(String(req.body.limit), 10))) : 50;
      const addresses = watchlist.length > 0 ? watchlist : [];

      if (addresses.length === 0) {
        return res.json({ inserted: 0, message: 'No addresses in watchlist' });
      }

      let totalInserted = 0;
      const results: Array<{ address: string; inserted: number }> = [];

      // Fetch fills for each address (limit concurrency)
      for (const address of addresses) {
        try {
          const fills = await fetchUserFills(address, { aggregateByTime: true, symbols: ['BTC', 'ETH'] });
          let inserted = 0;

          for (const f of (fills || []).slice(0, limit)) {
            const delta = f.side === 'B' ? +f.sz : -f.sz;
            const newPos = f.startPosition + delta;
            let action = '';
            if (f.startPosition === 0) action = delta > 0 ? 'Open Long (Open New)' : 'Open Short (Open New)';
            else if (f.startPosition > 0) action = delta > 0 ? 'Increase Long' : (newPos === 0 ? 'Close Long (Close All)' : 'Decrease Long');
            else action = delta < 0 ? 'Increase Short' : (newPos === 0 ? 'Close Short (Close All)' : 'Decrease Short');

            const payload = {
              at: new Date(f.time).toISOString(),
              address,
              symbol: f.coin,
              action,
              size: Math.abs(f.sz),
              startPosition: f.startPosition,
              priceUsd: f.px,
              realizedPnlUsd: f.closedPnl ?? null,
              fee: f.fee ?? null,
              feeToken: f.feeToken ?? null,
              hash: f.hash ?? null,
            };

            const result = await insertTradeIfNew(address, payload);
            if (result.inserted) inserted += 1;
          }

          results.push({ address, inserted });
          totalInserted += inserted;
        } catch (err: any) {
          logger.warn('fetch_history_address_failed', { address, err: err?.message });
          results.push({ address, inserted: 0 });
        }
      }

      logger.info('fetch_history_complete', { totalInserted, addressCount: addresses.length });

      // Return the fills from DB after backfill
      const dbFills = await getBackfillFills({ limit: 40, addresses });

      res.json({
        inserted: totalInserted,
        addressCount: addresses.length,
        results,
        fills: dbFills.fills,
        hasMore: dbFills.hasMore,
        oldestTime: dbFills.oldestTime
      });
    } catch (err: any) {
      logger.error('fetch_history_failed', { err: err?.message });
      res.status(500).json({ error: 'Failed to fetch historical fills' });
    }
  });

  const server = http.createServer(app);
  configureWebSocket(server);

  setInterval(async () => {
    try {
      watchlist = await fetchWatchlist();
      await tracker?.refresh();
      await refreshPriceFeed();
    } catch (err: any) {
      logger.warn('watchlist_poll_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }, 60000);
  setInterval(() => {
    void tracker?.ensureFreshSnapshots();
  }, 30000);

  const port = getPort(8080);
  server.listen(port, () => logger.info('hl-stream listening', { port }));
}

main().catch((err) => {
  logger.error('fatal_startup', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
