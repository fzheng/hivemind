import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { OpenAPIV3 } from 'openapi-types';
import {
  addAddress,
  removeAddress,
  CandidateEvent,
  CandidateEventSchema,
  createLogger,
  fetchUserBtcFills,
  getOwnerToken,
  getPool,
  getPort,
  initMetrics,
  createHistogram,
  insertTradeIfNew,
  listAddresses,
  publishJson,
  seedAddresses,
  ensureStream,
  connectNats,
  normalizeAddress,
  nowIso
} from '@hl/ts-lib';

const OWNER_TOKEN = getOwnerToken();
const logger = createLogger('hl-scout');
const metrics = initMetrics('hl_scout');
const candidateLatency = createHistogram(metrics, 'candidate_publish_seconds', 'Latency for publishing candidates', [0.01, 0.05, 0.1, 0.25, 0.5, 1]);

const swaggerDoc: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {
    title: 'hl-scout API',
    version: '0.1.0',
    description: 'Address management, seeding, and candidate publishing service.'
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      ownerToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-owner-key'
      }
    },
    schemas: {
      AddressPayload: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string', example: '0xabc123...' },
          nickname: { type: 'string', nullable: true }
        }
      },
      SeedPayload: {
        type: 'object',
        required: ['addresses'],
        properties: {
          addresses: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          }
        }
      },
      BackfillPayload: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 }
        }
      }
    }
  },
  paths: {
    '/healthz': {
      get: {
        summary: 'Service health',
        responses: {
          200: { description: 'OK' }
        }
      }
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics',
        responses: { 200: { description: 'Prometheus text payload' } }
      }
    },
    '/addresses': {
      get: {
        summary: 'List tracked addresses',
        responses: { 200: { description: 'Addresses with nicknames' } }
      },
      post: {
        summary: 'Add/update an address',
        security: [{ ownerToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AddressPayload' }
            }
          }
        },
        responses: { 200: { description: 'Added' } }
      }
    },
    '/addresses/{address}': {
      delete: {
        summary: 'Remove an address',
        security: [{ ownerToken: [] }],
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Removed' } }
      }
    },
    '/admin/seed': {
      post: {
        summary: 'Seed multiple addresses',
        security: [{ ownerToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SeedPayload' }
            }
          }
        },
        responses: { 200: { description: 'Seeded' } }
      }
    },
    '/admin/backfill/{address}': {
      post: {
        summary: 'Backfill recent fills for an address',
        security: [{ ownerToken: [] }],
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BackfillPayload' }
            }
          }
        },
        responses: { 200: { description: 'Backfill triggered' } }
      }
    }
  }
};

interface AddressPayload {
  address: string;
  nickname?: string | null;
}

function ownerOnly(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers['x-owner-key'] || req.headers['x-owner-token'] || '').toString();
  if (token !== OWNER_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}

const DEFAULT_SEEDS = (process.env.SCOUT_SEEDS || '0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222,0x3333333333333333333333333333333333333333')
  .split(',')
  .map((addr) => addr.trim().toLowerCase())
  .filter((addr) => addr.startsWith('0x') && addr.length === 42);

async function publishCandidate(
  subject: string,
  js: Awaited<ReturnType<typeof connectNats>>['js'],
  candidate: CandidateEvent
) {
  const parsed = CandidateEventSchema.parse(candidate);
  const end = (candidateLatency as any).startTimer?.({ operation: 'publish' });
  await publishJson(js, subject, parsed);
  end?.();
  logger.info('candidate_published', { address: parsed.address, source: parsed.source });
}

async function backfillRecent(address: string, limit = 50): Promise<number> {
  const fills = await fetchUserBtcFills(address, { aggregateByTime: true });
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
      symbol: 'BTC',
      action,
      size: Math.abs(f.sz),
      startPosition: f.startPosition,
      priceUsd: f.px,
      realizedPnlUsd: f.closedPnl ?? null,
      fee: (f as any).fee ?? null,
      feeToken: (f as any).feeToken ?? null,
      hash: (f as any).hash ?? null,
    };
    const result = await insertTradeIfNew(address, payload);
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

async function bootstrapCandidates(subject: string, js: Awaited<ReturnType<typeof connectNats>>['js']) {
  const rows = await listAddresses();
  if (rows.length === 0 && DEFAULT_SEEDS.length) {
    await seedAddresses(DEFAULT_SEEDS);
    rows.push(...await listAddresses());
  }
  const seeds = rows.slice(0, 3);
  for (const entry of seeds) {
    await publishCandidate(subject, js, {
      address: normalizeAddress(entry.address),
      source: 'seed',
      ts: nowIso(),
      tags: ['phase1'],
      nickname: entry.nickname || null,
      meta: { seeded: true }
    });
  }
}

async function main() {
  await getPool(); // ensure db connectivity
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  const topic = 'a.candidates.v1';
  const nats = await connectNats(natsUrl);
  await ensureStream(nats.jsm, 'HL_A', [topic]);
  await bootstrapCandidates(topic, nats.js);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'hl-scout' });
  });

  app.get('/metrics', metricsHandler(metrics));

  app.get('/addresses', async (_req, res) => {
    const addresses = await listAddresses();
    res.json({ addresses });
  });

  app.post('/addresses', ownerOnly, async (req, res) => {
    const body = req.body as AddressPayload;
    if (!body?.address) return res.status(400).json({ error: 'address required' });
    await addAddress(body.address, body.nickname || null);
  await publishCandidate(topic, nats.js, {
    address: normalizeAddress(body.address),
    source: 'backfill',
    ts: nowIso(),
    nickname: body.nickname || null,
    tags: ['api'],
    meta: { via: 'api' }
  });
    res.json({ ok: true });
  });

  app.delete('/addresses/:address', ownerOnly, async (req, res) => {
    await removeAddress(req.params.address);
    res.json({ ok: true });
  });

  app.post('/admin/seed', ownerOnly, async (req, res) => {
    const addresses: string[] = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    if (!addresses.length) return res.status(400).json({ error: 'addresses array required' });
    await seedAddresses(addresses);
  for (const address of addresses) {
    await publishCandidate(topic, nats.js, {
      address: normalizeAddress(address),
      source: 'seed',
      ts: nowIso(),
      tags: ['admin-seed'],
      meta: { seeded: true }
    });
  }
    res.json({ ok: true, count: addresses.length });
  });

  app.post('/admin/backfill/:address', ownerOnly, async (req, res) => {
    const address = normalizeAddress(req.params.address);
    const inserted = await backfillRecent(address, Number(req.body?.limit) || 50);
    res.json({ ok: true, inserted });
  });

  const port = getPort(8080);
  app.listen(port, () => {
    logger.info('hl-scout listening', { port });
  });
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
