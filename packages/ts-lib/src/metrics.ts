import client, { Histogram } from 'prom-client';
import type { Request, Response } from 'express';

export interface MetricsContext {
  registry: client.Registry;
  service: string;
}

export function initMetrics(service: string): MetricsContext {
  const registry = new client.Registry();
  client.collectDefaultMetrics({
    register: registry,
    prefix: `${service}_`,
  });
  return { registry, service };
}

export function createHistogram(
  ctx: MetricsContext,
  name: string,
  help: string,
  buckets?: number[]
): Histogram<string> {
  const metric = new client.Histogram({
    name: `${ctx.service}_${name}`,
    help,
    buckets: buckets ?? [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [ctx.registry],
    labelNames: ['operation'],
  });
  return metric;
}

export function metricsHandler(ctx: MetricsContext) {
  return async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', ctx.registry.contentType);
    res.send(await ctx.registry.metrics());
  };
}
