import { createLogger, getPool, normalizeAddress, nowIso, CandidateEventSchema } from '@hl/ts-lib';
import type { CandidateEvent } from '@hl/ts-lib';

const DEFAULT_API_URL = 'https://hyperbot.network/api/leaderboard/smart';

type LeaderboardRawEntry = {
  address: string;
  winRate?: number;
  executedOrders?: number;
  realizedPnl?: number;
  remark?: string | null;
  labels?: string[] | null;
  pnlList?: Array<{ timestamp: number; value: string }>;
};

export type RankedEntry = {
  address: string;
  rank: number;
  score: number;
  weight: number;
  winRate: number;
  executedOrders: number;
  realizedPnl: number;
  efficiency: number;
  pnlConsistency: number;
  remark: string | null;
  labels: string[];
  meta: any;
};

export interface LeaderboardOptions {
  apiUrl?: string;
  topN?: number;
  selectCount?: number;
  periods?: number[];
  pageSize?: number;
  refreshMs?: number;
}

export class LeaderboardService {
  private opts: Required<LeaderboardOptions>;
  private timer: NodeJS.Timeout | null = null;
  private logger = createLogger('leaderboard');
  private publishCandidate: (entry: CandidateEvent) => Promise<void>;

  constructor(opts: LeaderboardOptions, publishCandidate: (entry: CandidateEvent) => Promise<void>) {
    this.opts = {
      apiUrl: opts.apiUrl || DEFAULT_API_URL,
      topN: opts.topN ?? 1000,
      selectCount: opts.selectCount ?? 12,
      periods: opts.periods?.length ? opts.periods : [30],
      pageSize: opts.pageSize ?? 100,
      refreshMs: opts.refreshMs ?? 24 * 60 * 60 * 1000,
    };
    this.publishCandidate = publishCandidate;
  }

  start() {
    this.refreshAll().catch((err) => this.logger.error('leaderboard_refresh_failed', { err: err?.message }));
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.refreshAll().catch((err) => this.logger.error('leaderboard_refresh_failed', { err: err?.message }));
    }, this.opts.refreshMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshAll() {
    for (const period of this.opts.periods) {
      try {
        await this.refreshPeriod(period);
      } catch (err: any) {
        this.logger.error('leaderboard_period_failed', { period, err: err?.message });
      }
    }
  }

  async refreshPeriod(period: number) {
    const raw = await this.fetchPeriod(period);
    const ranked = this.scoreEntries(raw);
    await this.persistPeriod(period, ranked);
    await this.publishTopCandidates(period, ranked.slice(0, this.opts.selectCount));
    this.logger.info('leaderboard_updated', { period, count: ranked.length });
  }

  private async fetchPeriod(period: number): Promise<LeaderboardRawEntry[]> {
    const results: LeaderboardRawEntry[] = [];
    const pagesNeeded = Math.ceil(this.opts.topN / this.opts.pageSize);
    for (let page = 1; page <= pagesNeeded; page += 1) {
      const url = `${this.opts.apiUrl}?pageNum=${page}&pageSize=${this.opts.pageSize}&period=${period}&sort=3`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
      const payload = await res.json();
      const data: LeaderboardRawEntry[] = payload?.data || [];
      results.push(...data);
      if (data.length < this.opts.pageSize) break;
    }
    return results.slice(0, this.opts.topN);
  }

  private scoreEntries(entries: LeaderboardRawEntry[]): RankedEntry[] {
    const base = entries
      .map((entry) => {
        const address = normalizeAddress(entry.address);
        const winRate = clamp(Number(entry.winRate ?? 0), 0, 1);
        const executed = Number(entry.executedOrders ?? 0);
        const pnl = Number(entry.realizedPnl ?? 0);
        const efficiency = executed > 0 ? pnl / executed : pnl;
        const pnlConsistency = computeConsistency(entry.pnlList || []);
        const winScore = Math.pow(Math.min(winRate, 0.98), 0.8);
        const effScore = normalizeLog(Math.abs(efficiency), 1e3, 1e8);
        const pnlScore = normalizeLog(Math.abs(pnl), 1e5, 1e10);
        const score = 0.35 * winScore + 0.3 * pnlConsistency + 0.2 * effScore + 0.15 * pnlScore;
        return {
          address,
          score,
          winRate,
          executedOrders: executed,
          realizedPnl: pnl,
          efficiency,
          pnlConsistency,
          remark: entry.remark ?? null,
          labels: entry.labels || [],
          meta: entry,
        };
      })
      .filter((entry) => Number.isFinite(entry.score));
    let scored = base.filter((entry) => entry.winRate < 0.999);
    if (!scored.length) scored = base;
    scored.sort((a, b) => b.score - a.score);
    const totalScore = scored.slice(0, this.opts.selectCount).reduce((sum, e) => sum + e.score, 0) || 1;
    return scored.map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
      weight: idx < this.opts.selectCount ? entry.score / totalScore : 0,
    }));
  }

  private async persistPeriod(period: number, entries: RankedEntry[]): Promise<void> {
    const pool = await getPool();
    await pool.query('DELETE FROM hl_leaderboard_entries WHERE period_days = $1', [period]);
    if (!entries.length) return;
    const chunkSize = 100;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const values = chunk.flatMap((entry) => [
        period,
        entry.address,
        entry.rank,
        entry.score,
        entry.weight,
        entry.winRate,
        entry.executedOrders,
        entry.realizedPnl,
        entry.pnlConsistency,
        entry.efficiency,
        entry.remark,
        JSON.stringify(entry.labels || []),
        JSON.stringify({
          raw: entry.meta,
        }),
      ]);
      const placeholders = chunk
        .map(
          (_entry, idx) =>
            `($${idx * 13 + 1}, $${idx * 13 + 2}, $${idx * 13 + 3}, $${idx * 13 + 4}, $${idx * 13 + 5}, $${idx * 13 + 6}, $${idx * 13 + 7}, $${idx * 13 + 8}, $${idx * 13 + 9}, $${idx * 13 + 10}, $${idx * 13 + 11}, $${idx * 13 + 12}, $${idx * 13 + 13})`
        )
        .join(',');
      await pool.query(
        `
        INSERT INTO hl_leaderboard_entries (
          period_days, address, rank, score, weight, win_rate, executed_orders,
          realized_pnl, pnl_consistency, efficiency, remark, labels, metrics
        )
        VALUES ${placeholders}
      `,
        values
      );
    }
  }

  private async publishTopCandidates(period: number, entries: RankedEntry[]): Promise<void> {
    for (const entry of entries) {
      const candidate = CandidateEventSchema.parse({
        address: entry.address,
        source: 'leaderboard',
        ts: nowIso(),
        tags: [`period:${period}`, 'leaderboard'],
        nickname: entry.remark || undefined,
        score_hint: entry.score,
        meta: {
          leaderboard: {
            period_days: period,
            rank: entry.rank,
            weight: entry.weight,
            score: entry.score,
            winRate: entry.winRate,
            executedOrders: entry.executedOrders,
            realizedPnl: entry.realizedPnl,
            pnlConsistency: entry.pnlConsistency,
            efficiency: entry.efficiency,
            labels: entry.labels,
          },
        },
      });
      await this.publishCandidate(candidate).catch((err) =>
        this.logger.error('publish_candidate_failed', { address: entry.address, err: err?.message })
      );
    }
  }

  async getEntries(period: number, limit = this.opts.selectCount): Promise<RankedEntry[]> {
    const pool = await getPool();
    const { rows } = await pool.query(
      `
        SELECT
          address,
          rank,
          score,
          weight,
          coalesce(win_rate,0) as win_rate,
          coalesce(executed_orders,0) as executed_orders,
          coalesce(realized_pnl,0) as realized_pnl,
          coalesce(pnl_consistency,0) as pnl_consistency,
          coalesce(efficiency,0) as efficiency,
          remark,
          labels,
          metrics
        FROM hl_leaderboard_entries
        WHERE period_days = $1
        ORDER BY rank ASC
        LIMIT $2
      `,
      [period, limit]
    );
    return rows.map((row: any) => ({
      address: row.address,
      rank: Number(row.rank),
      score: Number(row.score),
      weight: Number(row.weight),
      winRate: Number(row.win_rate),
      executedOrders: Number(row.executed_orders),
      realizedPnl: Number(row.realized_pnl),
      pnlConsistency: Number(row.pnl_consistency),
      efficiency: Number(row.efficiency),
      remark: row.remark,
      labels: Array.isArray(row.labels) ? row.labels : [],
      meta: row.metrics,
    }));
  }

  async getSelected(period: number, limit = this.opts.selectCount): Promise<RankedEntry[]> {
    const pool = await getPool();
    const { rows } = await pool.query(
      `
        SELECT
          address,
          rank,
          score,
          weight,
          coalesce(win_rate,0) as win_rate,
          coalesce(executed_orders,0) as executed_orders,
          coalesce(realized_pnl,0) as realized_pnl,
          coalesce(pnl_consistency,0) as pnl_consistency,
          coalesce(efficiency,0) as efficiency,
          remark,
          labels,
          metrics
        FROM hl_leaderboard_entries
        WHERE period_days = $1
        ORDER BY weight DESC, rank ASC
        LIMIT $2
      `,
      [period, limit]
    );
    return rows.map((row: any) => ({
      address: row.address,
      rank: Number(row.rank),
      score: Number(row.score),
      weight: Number(row.weight),
      winRate: Number(row.win_rate),
      executedOrders: Number(row.executed_orders),
      realizedPnl: Number(row.realized_pnl),
      pnlConsistency: Number(row.pnl_consistency),
      efficiency: Number(row.efficiency),
      remark: row.remark,
      labels: Array.isArray(row.labels) ? row.labels : [],
      meta: row.metrics,
    }));
  }

  async ensureSeeded(): Promise<void> {
    const pool = await getPool();
    for (const period of this.opts.periods) {
      const { rows } = await pool.query(
        'SELECT 1 FROM hl_leaderboard_entries WHERE period_days = $1 LIMIT 1',
        [period]
      );
      if (!rows.length) {
        this.logger.info('leaderboard_empty_seed', { period });
        await this.refreshPeriod(period);
      }
    }
  }
}

export default LeaderboardService;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLog(value: number, minRef: number, maxRef: number): number {
  if (value <= 0) return 0;
  const logValue = Math.log10(value);
  const minLog = Math.log10(minRef);
  const maxLog = Math.log10(maxRef);
  return clamp((logValue - minLog) / (maxLog - minLog), 0, 1);
}

function computeConsistency(list: Array<{ timestamp: number; value: string }>): number {
  if (!list?.length) return 0.5;
  const values = list.map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
  if (values.length < 3) return 0.5;
  const first = values[0];
  const last = values[values.length - 1];
  const slope = (last - first) / Math.max(Math.abs(first) + 1, 1);
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    diffs.push(values[i] - values[i - 1]);
  }
  const variance = diffs.reduce((sum, d) => sum + d * d, 0) / diffs.length || 0;
  const std = Math.sqrt(variance) || 1;
  const ratio = slope / std;
  return clamp(0.5 + Math.atan(ratio) / Math.PI, 0, 1);
}
