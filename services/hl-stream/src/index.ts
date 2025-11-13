import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import swaggerUi from 'swagger-ui-express';
import type { OpenAPIV3 } from 'openapi-types';
import {
  EventQueue,
  createHistogram,
  createLogger,
  getOwnerToken,
  getPort,
  initMetrics,
  normalizeAddress,
  nowIso,
  connectNats,
  ensureStream,
  publishJson,
  FillEvent,
  FillEventSchema
} from '@hl/ts-lib';

const OWNER_TOKEN = getOwnerToken();
const logger = createLogger('hl-stream');
const metrics = initMetrics('hl_stream');
const fillsHistogram = createHistogram(metrics, 'fills_publish_seconds', 'Latency for publishing fills', [0.005, 0.01, 0.05, 0.1]);

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
const scoutUrl = process.env.SCOUT_URL || 'http://localhost:4101';

function ownerOnly(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers['x-owner-key'] || req.headers['x-owner-token'] || '').toString();
  if (token !== OWNER_TOKEN) return res.status(403).json({ error: 'forbidden' });
  return next();
}

async function fetchWatchlist(): Promise<string[]> {
  const res = await fetch(`${scoutUrl}/addresses`, {
    headers: { 'x-owner-key': OWNER_TOKEN }
  });
  if (!res.ok) throw new Error(`scout HTTP ${res.status}`);
  const data = await res.json();
  return (data?.addresses || []).map((entry: any) => normalizeAddress(entry.address));
}

function buildFakeFill(address: string): FillEvent {
  const side = Math.random() > 0.5 ? 'buy' : 'sell';
  const size = Number((Math.random() * 0.5 + 0.01).toFixed(4));
  const price = Number((60000 + Math.random() * 500 - 250).toFixed(2));
  return FillEventSchema.parse({
    fill_id: `${address}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    source: 'fake',
    address,
    asset: 'BTC',
    side,
    size,
    price,
    start_position: null,
    realized_pnl: null,
    ts: nowIso(),
    meta: { generator: 'fake' }
  });
}

async function publishFill(
  js: Awaited<ReturnType<typeof connectNats>>['js'],
  subject: string,
  fill: FillEvent
) {
  const end = (fillsHistogram as any).startTimer?.({ operation: 'publish' });
  await publishJson(js, subject, fill);
  end?.();
  queue.push({
    type: 'trade',
    at: fill.ts,
    address: fill.address,
    symbol: 'BTC',
    side: fill.side === 'buy' ? 'buy' : 'sell',
    direction: fill.side === 'buy' ? 'long' : 'short',
    effect: fill.side === 'buy' ? 'open' : 'close',
    priceUsd: fill.price,
    size: fill.size
  } as any);
}

function configureWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
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
  });

  setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        try { client.ws.terminate(); } catch {}
        clients.delete(client);
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch {}
    }
  }, 30000);

  const broadcast = () => {
    if (!clients.size) return;
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const events = queue.listSince(client.lastSeq, 200);
      if (events.length) {
        client.lastSeq = events[events.length - 1].seq;
        client.ws.send(JSON.stringify({ type: 'events', events }));
      }
    }
  };

  setInterval(broadcast, 1000);
}

async function main() {
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  const nats = await connectNats(natsUrl);
  const subject = 'c.fills.v1';
  await ensureStream(nats.jsm, 'HL_C', [subject]);

  watchlist = await fetchWatchlist();
  logger.info('watchlist_loaded', { count: watchlist.length });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', watchlist: watchlist.length }));
  app.get('/metrics', metricsHandler(metrics));
  app.get('/watchlist', (_req, res) => res.json({ addresses: watchlist }));

  app.post('/watchlist/refresh', ownerOnly, async (_req, res) => {
    watchlist = await fetchWatchlist();
    logger.info('watchlist_refreshed', { count: watchlist.length });
    res.json({ ok: true, count: watchlist.length });
  });

  const server = http.createServer(app);
  configureWebSocket(server);

  const loop = () => {
    if (!watchlist.length) return;
    for (const addr of watchlist) {
      const fill = buildFakeFill(addr);
      publishFill(nats.js, subject, fill).catch((err) => logger.error('fill_publish_failed', { err: err?.message }));
    }
  };
  setInterval(loop, 1000);
  setInterval(async () => {
    try {
      watchlist = await fetchWatchlist();
    } catch (err) {
      logger.warn('watchlist_poll_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }, 60000);

  const port = getPort(8080);
  server.listen(port, () => logger.info('hl-stream listening', { port }));
}

function metricsHandler(ctx: ReturnType<typeof initMetrics>) {
  return async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', ctx.registry.contentType);
    res.send(await ctx.registry.metrics());
  };
}

main().catch((err) => {
  logger.error('fatal_startup', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
