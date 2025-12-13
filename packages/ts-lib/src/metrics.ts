/**
 * Prometheus Metrics Module
 *
 * Provides helpers for collecting and exposing Prometheus metrics.
 * Each service should initialize its own metrics context and expose
 * a /metrics endpoint.
 *
 * @module metrics
 */

import client, { Histogram, Counter, Gauge } from 'prom-client';
import type { Request, Response } from 'express';
import { getRateLimiterMetrics } from './hyperliquid';

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
 * Creates a counter metric.
 *
 * @param ctx - Metrics context from initMetrics
 * @param name - Metric name (will be prefixed with service name)
 * @param help - Human-readable description of the metric
 * @param labelNames - Optional label names for this counter
 * @returns Prometheus Counter instance
 */
export function createCounter(
  ctx: MetricsContext,
  name: string,
  help: string,
  labelNames?: string[]
): Counter<string> {
  const metric = new Counter({
    name: `${ctx.service}_${name}`,
    help,
    registers: [ctx.registry],
    labelNames: labelNames ?? [],
  });
  return metric;
}

/**
 * Creates a gauge metric.
 *
 * @param ctx - Metrics context from initMetrics
 * @param name - Metric name (will be prefixed with service name)
 * @param help - Human-readable description of the metric
 * @param labelNames - Optional label names for this gauge
 * @returns Prometheus Gauge instance
 */
export function createGauge(
  ctx: MetricsContext,
  name: string,
  help: string,
  labelNames?: string[]
): Gauge<string> {
  const metric = new Gauge({
    name: `${ctx.service}_${name}`,
    help,
    registers: [ctx.registry],
    labelNames: labelNames ?? [],
  });
  return metric;
}

// Rate limiter metrics (lazily initialized per service)
let rateLimiterMetricsInitialized = false;
let rateLimitHitsCounter: Counter<string> | null = null;
let rateLimitRetriesCounter: Counter<string> | null = null;
let rateLimitWeightGauge: Gauge<string> | null = null;
let rateLimitBudgetUsageGauge: Gauge<string> | null = null;

/**
 * Initialize rate limiter metrics for a service.
 * Call this once during service startup.
 */
export function initRateLimiterMetrics(ctx: MetricsContext): void {
  if (rateLimiterMetricsInitialized) return;

  rateLimitHitsCounter = createCounter(ctx, 'hl_rate_limit_hits_total', 'Total 429 errors from Hyperliquid API');
  rateLimitRetriesCounter = createCounter(ctx, 'hl_rate_limit_retries_total', 'Total retries attempted after rate limit');
  rateLimitWeightGauge = createGauge(ctx, 'hl_rate_limit_weight_consumed', 'API weight consumed in current minute window');
  rateLimitBudgetUsageGauge = createGauge(ctx, 'hl_rate_limit_budget_usage_pct', 'Percentage of weight budget used (0-100)');

  rateLimiterMetricsInitialized = true;
}

/**
 * Update rate limiter metrics from the global rate limiter state.
 * Call this periodically or before metrics scraping.
 */
function updateRateLimiterMetrics(): void {
  if (!rateLimiterMetricsInitialized) return;

  const stats = getRateLimiterMetrics();
  if (rateLimitHitsCounter) {
    // Reset and set to current value (counters should only increase)
    // We use the diff approach - track last value
  }
  if (rateLimitWeightGauge) {
    rateLimitWeightGauge.set(stats.weightConsumedThisMinute);
  }
  if (rateLimitBudgetUsageGauge) {
    const budgetPerMinute = Number(process.env.HL_SDK_WEIGHT_BUDGET ?? 800);
    rateLimitBudgetUsageGauge.set((stats.weightConsumedThisMinute / budgetPerMinute) * 100);
  }
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
    // Update rate limiter metrics before scraping
    updateRateLimiterMetrics();

    res.setHeader('Content-Type', ctx.registry.contentType);
    res.send(await ctx.registry.metrics());
  };
}
