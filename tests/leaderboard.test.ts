jest.mock('@hl/ts-lib', () => {
  // Import actual scoring functions (don't mock them)
  const actualScoring = jest.requireActual('@hl/ts-lib/scoring');

  return {
    createLogger: () => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    }),
    getPool: jest.fn(async () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    })),
    normalizeAddress: (value: string) => value.toLowerCase(),
    nowIso: () => '2024-01-01T00:00:00.000Z',
    CandidateEventSchema: { parse: (input: any) => input },
    // Include scoring functions from actual module
    computePerformanceScore: actualScoring.computePerformanceScore,
    computeStabilityScore: actualScoring.computeStabilityScore,
    DEFAULT_SCORING_PARAMS: actualScoring.DEFAULT_SCORING_PARAMS,
  };
});

import LeaderboardService from '../services/hl-scout/src/leaderboard';

type RawEntry = {
  address: string;
  winRate: number;
  executedOrders: number;
  realizedPnl: number;
  pnlList: Array<{ timestamp: number; value: string }>;
  remark?: string | null;
  labels?: string[];
  lastOperationAt?: number;
  stats?: {
    maxDrawdown?: number;
    totalPnl?: number;
    openPosCount?: number;
    closePosCount?: number;
  };
};

function makeEntry(overrides: Partial<RawEntry> = {}): RawEntry {
  return {
    address: overrides.address ?? `0x${Math.random().toString(16).slice(2, 42).padEnd(40, '0')}`,
    winRate: overrides.winRate ?? 0.65,
    executedOrders: overrides.executedOrders ?? 100,
    realizedPnl: overrides.realizedPnl ?? 50_000,
    pnlList:
      overrides.pnlList ??
      [
        { timestamp: 1, value: '0' },
        { timestamp: 2, value: '10000' },
        { timestamp: 3, value: '20000' },
        { timestamp: 4, value: '30000' },
        { timestamp: 5, value: '40000' },
        { timestamp: 6, value: '50000' },
      ],
    remark: overrides.remark ?? null,
    labels: overrides.labels ?? [],
    lastOperationAt: overrides.lastOperationAt ?? Date.now(), // Default to active (now)
    stats: overrides.stats,
  };
}

function buildService(selectCount = 2) {
  return new LeaderboardService(
    {
      apiUrl: 'https://example.com',
      topN: 100,
      selectCount,
      periods: [30],
      pageSize: 50,
      refreshMs: 24 * 60 * 60 * 1000,
    },
    async () => {}
  );
}

describe('LeaderboardService scoreEntries', () => {
  it('filters out accounts with perfect win rate and many trades', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({ address: '0xperfect', winRate: 1, executedOrders: 50 }), // Perfect win rate with many trades
      makeEntry({ address: '0xnormal', winRate: 0.75, executedOrders: 100 }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Perfect win rates with > 10 trades are filtered
    expect(scored.some((row: any) => row.address === '0xperfect')).toBe(false);
    expect(scored[0].address).toBe('0xnormal');
  });

  it('allows perfect win rate with few trades', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({ address: '0xperfect', winRate: 1, executedOrders: 5 }), // Few trades is OK
      makeEntry({ address: '0xnormal', winRate: 0.75, executedOrders: 100 }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Perfect win rate with < 10 trades is allowed
    expect(scored.some((row: any) => row.address === '0xperfect')).toBe(true);
  });

  it('falls back to base list when filter removes everyone', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({ address: '0xalpha', winRate: 1, executedOrders: 50 }),
      makeEntry({ address: '0xbeta', winRate: 1, executedOrders: 50 }),
    ];
    const scored = (service as any).scoreEntries(entries);
    expect(scored).toHaveLength(entries.length);
  });

  it('normalizes weights across selectCount addresses', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({
        address: '0x1',
        realizedPnl: 100_000,
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '25000' },
          { timestamp: 3, value: '50000' },
          { timestamp: 4, value: '75000' },
          { timestamp: 5, value: '100000' },
        ],
      }),
      makeEntry({
        address: '0x2',
        realizedPnl: 50_000,
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '12500' },
          { timestamp: 3, value: '25000' },
          { timestamp: 4, value: '37500' },
          { timestamp: 5, value: '50000' },
        ],
      }),
      makeEntry({
        address: '0x3',
        realizedPnl: 25_000,
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '6000' },
          { timestamp: 3, value: '12000' },
          { timestamp: 4, value: '18000' },
          { timestamp: 5, value: '25000' },
        ],
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    const topWeights = scored.slice(0, 2).map((row: any) => row.weight);
    expect(topWeights[0]).toBeGreaterThan(0);
    expect(topWeights[1]).toBeGreaterThan(0);
    expect(topWeights[0] + topWeights[1]).toBeCloseTo(1, 6);
    expect(scored[2].weight).toBe(0);
  });

  it('includes stabilityScore in scoring details', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({
        address: '0xtest',
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '10000' },
          { timestamp: 3, value: '20000' },
          { timestamp: 4, value: '30000' },
        ],
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    expect(scored[0].meta.scoringDetails).toBeDefined();
    expect(scored[0].meta.scoringDetails.stabilityScore).toBeGreaterThan(0);
  });

  it('penalizes accounts with high drawdown via stability score', () => {
    const service = buildService(2);
    // Create a PnL series with high drawdown: goes up to 100k, then crashes to 10k
    const badDrawdownPnlList = [
      { timestamp: 1, value: '0' },
      { timestamp: 2, value: '50000' },
      { timestamp: 3, value: '100000' },  // Peak
      { timestamp: 4, value: '30000' },   // 70% drawdown
      { timestamp: 5, value: '110000' },  // Recovers (still profitable overall)
    ];
    // Normal account with small drawdown
    const goodPnlList = [
      { timestamp: 1, value: '0' },
      { timestamp: 2, value: '25000' },
      { timestamp: 3, value: '50000' },
      { timestamp: 4, value: '45000' },  // Small 10% dip
      { timestamp: 5, value: '60000' },
    ];
    const entries = [
      makeEntry({ address: '0xbad_drawdown', pnlList: badDrawdownPnlList }),
      makeEntry({ address: '0xgood', pnlList: goodPnlList }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Good account should rank higher due to stability score penalty on bad drawdown
    expect(scored[0].address).toBe('0xgood');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('includes maxDrawdown in scoring details', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({
        address: '0xtest',
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '100000' },
          { timestamp: 3, value: '70000' },  // 30% drawdown
          { timestamp: 4, value: '90000' },
        ],
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    expect(scored[0].meta.scoringDetails.maxDrawdown).toBeDefined();
    expect(scored[0].meta.scoringDetails.maxDrawdown).toBeCloseTo(0.3, 1);
    expect(scored[0].statMaxDrawdown).toBeCloseTo(0.3, 1);
  });

  it('applies progressive penalty for high trade counts (>100)', () => {
    const service = buildService(2);
    const entries = [
      // Moderate trader - should score better
      makeEntry({
        address: '0xmoderate',
        executedOrders: 80,
        winRate: 0.65,
        realizedPnl: 50000,
      }),
      // Heavy trader (scalper) - should be penalized progressively (>100 trades)
      makeEntry({
        address: '0xscalper',
        executedOrders: 150,  // 150 trades should get penalty
        winRate: 0.65,
        realizedPnl: 50000,
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Moderate trader should rank higher due to trade frequency penalty on heavy trader
    expect(scored[0].address).toBe('0xmoderate');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('removes accounts with > 200 trades (hard limit)', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({
        address: '0xnormal',
        executedOrders: 100,
        winRate: 0.6,
        realizedPnl: 30000,
      }),
      makeEntry({
        address: '0xextreme_scalper',
        executedOrders: 250,  // 250 trades > 200 max - should be removed entirely
        winRate: 0.7,
        realizedPnl: 100000,
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Scalper should be completely removed from results
    expect(scored.length).toBe(1);
    expect(scored[0].address).toBe('0xnormal');
    // Scalper should not exist in results
    const scalper = scored.find((r: any) => r.address === '0xextreme_scalper');
    expect(scalper).toBeUndefined();
  });

  it('removes accounts inactive for > 14 days', () => {
    const service = buildService(2);
    const now = Date.now();
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000; // 15 days ago
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago

    const entries = [
      makeEntry({
        address: '0xactive',
        executedOrders: 50,
        winRate: 0.6,
        realizedPnl: 30000,
        lastOperationAt: tenDaysAgo, // Active within 14 days
      }),
      makeEntry({
        address: '0xinactive',
        executedOrders: 50,
        winRate: 0.7,
        realizedPnl: 50000,
        lastOperationAt: fifteenDaysAgo, // Inactive for > 14 days
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Inactive account should be completely removed
    expect(scored.length).toBe(1);
    expect(scored[0].address).toBe('0xactive');
    // Inactive should not exist in results
    const inactive = scored.find((r: any) => r.address === '0xinactive');
    expect(inactive).toBeUndefined();
  });

  it('filters out accounts with < 3 trades (hard minimum)', () => {
    const service = buildService(2);
    const entries = [
      makeEntry({
        address: '0xnormal',
        executedOrders: 50,
        winRate: 0.6,
        realizedPnl: 30000,
      }),
      makeEntry({
        address: '0xtoo_few_trades',
        executedOrders: 2,  // Only 2 trades < 3 minimum
        winRate: 0.8,
        realizedPnl: 50000,
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Normal trader should rank higher
    expect(scored[0].address).toBe('0xnormal');
    // Too few trades should have tradeFreqScore = 0
    const tooFew = scored.find((r: any) => r.address === '0xtoo_few_trades');
    expect(tooFew.meta.scoringDetails.tradeFreqScore).toBe(0);
  });

  it('applies progressive penalty for low win rates (<60%)', () => {
    const service = buildService(2);
    const entries = [
      // Good win rate
      makeEntry({
        address: '0xgood_wr',
        winRate: 0.70,
        executedOrders: 50,
        realizedPnl: 50000,
      }),
      // Low win rate
      makeEntry({
        address: '0xlow_wr',
        winRate: 0.45,  // Below 60% threshold
        executedOrders: 50,
        realizedPnl: 50000,
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Good win rate should rank higher
    expect(scored[0].address).toBe('0xgood_wr');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('marks non-profitable accounts as filtered with low score', () => {
    const service = buildService(2);
    const entries = [
      // Profitable account
      makeEntry({
        address: '0xprofitable',
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '10000' },
          { timestamp: 3, value: '20000' },
        ],
      }),
      // Non-profitable account (ends lower than start)
      makeEntry({
        address: '0xnot_profitable',
        pnlList: [
          { timestamp: 1, value: '0' },
          { timestamp: 2, value: '10000' },
          { timestamp: 3, value: '-5000' },  // Ends in loss
        ],
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Profitable should rank first
    expect(scored[0].address).toBe('0xprofitable');
    // Non-profitable has very low or zero stability score
    const notProfitable = scored.find((row: any) => row.address === '0xnot_profitable');
    if (notProfitable) {
      expect(notProfitable.score).toBeLessThan(scored[0].score);
      // The stability score should be 0 for non-profitable
      expect(notProfitable.meta.scoringDetails.stabilityScore).toBe(0);
    }
  });

  it('rewards large PnL as tiebreaker', () => {
    const service = buildService(2);
    // Two accounts with similar stability but different PnL
    const samePnlList = [
      { timestamp: 1, value: '0' },
      { timestamp: 2, value: '25000' },
      { timestamp: 3, value: '50000' },
      { timestamp: 4, value: '75000' },
      { timestamp: 5, value: '100000' },
    ];
    const entries = [
      makeEntry({
        address: '0xlarge_pnl',
        winRate: 0.65,
        executedOrders: 50,
        realizedPnl: 500000,  // Large PnL
        pnlList: samePnlList,
      }),
      makeEntry({
        address: '0xsmall_pnl',
        winRate: 0.65,
        executedOrders: 50,
        realizedPnl: 10000,  // Small PnL
        pnlList: samePnlList,
      }),
    ];
    const scored = (service as any).scoreEntries(entries);
    // Large PnL should rank higher as tiebreaker
    expect(scored[0].address).toBe('0xlarge_pnl');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });
});
