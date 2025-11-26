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
  insertTradeIfNew
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

const queue = new EventQueue(5000);
const clients = new Set<{ ws: WebSocket; lastSeq: number; alive: boolean }>();
let watchlist: string[] = [];
const scoutUrl = process.env.SCOUT_URL || 'http://hl-scout:8080';
const dashboardDir = path.resolve(__dirname, '..', 'public');
const fillsSubject = 'c.fills.v1';
let tracker: RealtimeTracker | null = null;

function ownerOnly(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers['x-owner-key'] || req.headers['x-owner-token'] || '').toString();
  if (token !== OWNER_TOKEN) return res.status(403).json({ error: 'forbidden' });
  return next();
}

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

function configureWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let pingInterval: NodeJS.Timeout | null = null;
  let broadcastInterval: NodeJS.Timeout | null = null;

  wss.on('connection', (ws) => {
    const client = { ws, lastSeq: 0, alive: true };
    clients.add(client);
    ws.send(JSON.stringify({ type: 'hello', latestSeq: queue.latestSeq() }));
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

  broadcastInterval = setInterval(broadcast, 1000);

  // Cleanup on server shutdown
  process.on('SIGTERM', () => {
    if (pingInterval) clearInterval(pingInterval);
    if (broadcastInterval) clearInterval(broadcastInterval);
    wss.close();
  });
}

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
