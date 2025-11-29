/**
 * Prometheus Metrics Module
 *
 * Provides helpers for collecting and exposing Prometheus metrics.
 * Each service should initialize its own metrics context and expose
 * a /metrics endpoint.
 *
 * @module metrics
 */

import client, { Histogram } from 'prom-client';
import type { Request, Response } from 'express';

/**
 * Context object containing the metrics registry and service name.
 * Passed to metric creation functions and the metrics handler.
 */
export interface MetricsContext {
  /** Prometheus metrics registry */
  registry: client.Registry;
  /** Service name prefix for metrics */
  service: string;
}

/**
 * Initializes Prometheus metrics collection for a service.
 * Sets up default metrics (CPU, memory, event loop) with service prefix.
 *
 * @param service - Service name used as metric prefix
 * @returns Metrics context for creating additional metrics
 *
 * @example
 * ```typescript
 * const metrics = initMetrics('hl_scout');
 * // Creates metrics like: hl_scout_process_cpu_user_seconds_total
 * ```
 */
export function initMetrics(service: string): MetricsContext {
  const registry = new client.Registry();
  client.collectDefaultMetrics({
    register: registry,
    prefix: `${service}_`,
  });
  return { registry, service };
}

/**
 * Creates a histogram metric for measuring operation durations.
 * Automatically prefixes the metric name with the service name.
 *
 * @param ctx - Metrics context from initMetrics
 * @param name - Metric name (will be prefixed with service name)
 * @param help - Human-readable description of the metric
 * @param buckets - Histogram bucket boundaries in seconds (default: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2])
 * @returns Prometheus Histogram instance
 *
 * @example
 * ```typescript
 * const requestDuration = createHistogram(ctx, 'request_duration_seconds', 'HTTP request duration');
 * const end = requestDuration.startTimer({ operation: 'fetch_leaderboard' });
 * // ... do work ...
 * end(); // Records duration
 * ```
 */
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

/**
 * Creates an Express request handler for the /metrics endpoint.
 * Returns Prometheus-formatted metrics for scraping.
 *
 * @param ctx - Metrics context from initMetrics
 * @returns Express request handler
 *
 * @example
 * ```typescript
 * const metrics = initMetrics('hl_scout');
 * app.get('/metrics', metricsHandler(metrics));
 * ```
 */
export function metricsHandler(ctx: MetricsContext) {
  return async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', ctx.registry.contentType);
    res.send(await ctx.registry.metrics());
  };
}
