/**
 * Tests for the scoring module
 */
import {
  computeStabilityScore,
  computeWinRateScore,
  computeTradeFreqScore,
  computeNormalizedPnl,
  computePerformanceScore,
  rankAccounts,
  DEFAULT_SCORING_PARAMS,
  type AccountStats,
  type PnlPoint,
  type RankableAccount,
} from '@hl/ts-lib/scoring';

describe('computeStabilityScore', () => {
  it('returns zero for empty or single-point pnlList', () => {
    expect(computeStabilityScore([]).score).toBe(0);
    expect(computeStabilityScore([100]).score).toBe(0);
  });

  it('returns zero for non-profitable series (ends lower than start)', () => {
    const result = computeStabilityScore([100, 200, 50]);
    expect(result.score).toBe(0);
    expect(result.isProfitable).toBe(false);
  });

  it('returns positive score for profitable series', () => {
    const result = computeStabilityScore([0, 100, 200, 300]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.isProfitable).toBe(true);
  });

  it('handles array format [timestamp, pnl]', () => {
    const pnlList: PnlPoint[] = [
      [1000, 0],
      [2000, 100],
      [3000, 200],
      [4000, 300],
    ];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBeGreaterThan(0);
    expect(result.isProfitable).toBe(true);
  });

  it('handles object format with value field', () => {
    const pnlList: PnlPoint[] = [
      { timestamp: 1000, value: 0 },
      { timestamp: 2000, value: 100 },
      { timestamp: 3000, value: 200 },
    ];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles object format with pnl field', () => {
    const pnlList: PnlPoint[] = [
      { timestamp: 1000, pnl: 0 },
      { timestamp: 2000, pnl: 100 },
      { timestamp: 3000, pnl: 200 },
    ];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles string values in pnlList', () => {
    const pnlList: PnlPoint[] = [
      { timestamp: 1000, value: '0' },
      { timestamp: 2000, value: '100' },
      { timestamp: 3000, value: '200' },
    ];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles array format [timestamp, string]', () => {
    const pnlList: PnlPoint[] = [
      [1000, '0'],
      [2000, '100'],
      [3000, '200'],
    ];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBeGreaterThan(0);
  });

  it('calculates maxDrawdown correctly', () => {
    // Series that goes up to 100, drops to 50 (50% drawdown), then recovers
    const pnlList = [0, 100, 50, 150];
    const result = computeStabilityScore(pnlList);
    expect(result.maxDrawdown).toBeGreaterThan(0);
    expect(result.maxDrawdown).toBeLessThanOrEqual(1);
  });

  it('calculates upFraction correctly', () => {
    // 3 up moves out of 4 total moves
    const pnlList = [0, 100, 200, 150, 250];
    const result = computeStabilityScore(pnlList);
    expect(result.upFraction).toBeCloseTo(0.75, 2);
  });

  it('penalizes high drawdown series', () => {
    // Smooth upward series
    const smooth = computeStabilityScore([0, 25, 50, 75, 100]);
    // Volatile series with same endpoint
    const volatile = computeStabilityScore([0, 100, 30, 80, 100]);

    expect(smooth.score).toBeGreaterThan(volatile.score);
  });

  it('returns zero for flat series (no movement)', () => {
    const result = computeStabilityScore([100, 100, 100, 100]);
    expect(result.score).toBe(0);
  });

  it('respects D0 and S0 parameters', () => {
    const pnlList = [0, 100, 50, 150];
    const strict = computeStabilityScore(pnlList, 0.10, 0.01); // Stricter
    const lenient = computeStabilityScore(pnlList, 0.50, 0.10); // More lenient

    expect(lenient.score).toBeGreaterThan(strict.score);
  });

  it('filters out invalid values in pnlList', () => {
    const pnlList: PnlPoint[] = [
      0,
      100,
      NaN,
      200,
      Infinity,
      300,
    ];
    const result = computeStabilityScore(pnlList);
    // Should still work with valid values
    expect(result.score).toBeGreaterThan(0);
  });

  it('returns zero when all pnlList values are invalid except one', () => {
    // Only one valid value after filtering
    const pnlList: PnlPoint[] = [100, NaN, Infinity, NaN];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBe(0);
  });

  it('returns zero for all-same profitable values (no movement)', () => {
    // All values are the same positive number - technically "profitable" but no movement
    // This tests the span <= 0 condition
    const pnlList: PnlPoint[] = [100, 100, 100, 100];
    const result = computeStabilityScore(pnlList);
    expect(result.score).toBe(0);
  });
});

describe('computeWinRateScore', () => {
  it('returns 0 for perfect 100% win rate (suspicious)', () => {
    expect(computeWinRateScore(1.0)).toBe(0);
    expect(computeWinRateScore(0.999)).toBe(0);
  });

  it('returns full score for win rate above threshold', () => {
    expect(computeWinRateScore(0.70, 0.60)).toBeCloseTo(0.70, 2);
    expect(computeWinRateScore(0.80, 0.60)).toBeCloseTo(0.80, 2);
  });

  it('caps score at 1.0 for very high win rates', () => {
    expect(computeWinRateScore(0.95, 0.60)).toBeLessThanOrEqual(1.0);
  });

  it('applies mild penalty for 55-60% win rate', () => {
    const score = computeWinRateScore(0.57, 0.60);
    expect(score).toBeCloseTo(0.57 * 0.85, 2);
  });

  it('applies moderate penalty for 50-55% win rate', () => {
    const score = computeWinRateScore(0.52, 0.60);
    expect(score).toBeCloseTo(0.52 * 0.7, 2);
  });

  it('applies severe penalty for 45-50% win rate', () => {
    const score = computeWinRateScore(0.47, 0.60);
    expect(score).toBeCloseTo(0.47 * 0.5, 2);
  });

  it('applies very severe penalty for 40-45% win rate', () => {
    const score = computeWinRateScore(0.42, 0.60);
    expect(score).toBeCloseTo(0.42 * 0.3, 2);
  });

  it('applies extreme penalty for 35-40% win rate', () => {
    const score = computeWinRateScore(0.37, 0.60);
    expect(score).toBeCloseTo(0.37 * 0.15, 2);
  });

  it('applies near-zero penalty for below 35% win rate', () => {
    const score = computeWinRateScore(0.30, 0.60);
    expect(score).toBeCloseTo(0.30 * 0.05, 2);
  });

  it('uses custom threshold', () => {
    // 55% is above 50% threshold, so no penalty
    expect(computeWinRateScore(0.55, 0.50)).toBeCloseTo(0.55, 2);
    // 55% is below 60% threshold, so mild penalty
    expect(computeWinRateScore(0.55, 0.60)).toBeLessThan(0.55);
  });
});

describe('computeTradeFreqScore', () => {
  it('returns 0 for trades below minimum', () => {
    expect(computeTradeFreqScore(2, 3, 200, 100)).toBe(0);
    expect(computeTradeFreqScore(0, 3, 200, 100)).toBe(0);
  });

  it('returns 0 for trades above maximum', () => {
    expect(computeTradeFreqScore(250, 3, 200, 100)).toBe(0);
    expect(computeTradeFreqScore(201, 3, 200, 100)).toBe(0);
  });

  it('returns 1.0 for trades under threshold', () => {
    expect(computeTradeFreqScore(50, 3, 200, 100)).toBe(1.0);
    expect(computeTradeFreqScore(100, 3, 200, 100)).toBe(1.0);
  });

  it('applies mild penalty for 100-125 trades', () => {
    expect(computeTradeFreqScore(110, 3, 200, 100)).toBe(0.85);
    expect(computeTradeFreqScore(125, 3, 200, 100)).toBe(0.85);
  });

  it('applies moderate penalty for 125-150 trades', () => {
    expect(computeTradeFreqScore(140, 3, 200, 100)).toBe(0.7);
  });

  it('applies severe penalty for 150-175 trades', () => {
    expect(computeTradeFreqScore(160, 3, 200, 100)).toBe(0.5);
  });

  it('applies very severe penalty for 175-200 trades', () => {
    expect(computeTradeFreqScore(190, 3, 200, 100)).toBe(0.3);
    expect(computeTradeFreqScore(200, 3, 200, 100)).toBe(0.3);
  });

  it('uses default parameters', () => {
    expect(computeTradeFreqScore(50)).toBe(1.0);
    expect(computeTradeFreqScore(2)).toBe(0);
  });
});

describe('computeNormalizedPnl', () => {
  it('returns 0 for non-positive PnL', () => {
    expect(computeNormalizedPnl(0)).toBe(0);
    expect(computeNormalizedPnl(-1000)).toBe(0);
  });

  it('returns 0 for non-finite PnL', () => {
    expect(computeNormalizedPnl(NaN)).toBe(0);
    expect(computeNormalizedPnl(Infinity)).toBe(0);
  });

  it('returns approximately 0.3 for PnL equal to reference', () => {
    const score = computeNormalizedPnl(100000, 100000);
    expect(score).toBeCloseTo(0.3, 1);
  });

  it('returns approximately 1.0 for PnL = 10x reference', () => {
    const score = computeNormalizedPnl(1000000, 100000);
    expect(score).toBeCloseTo(1.0, 1);
  });

  it('caps at 1.0 for very large PnL', () => {
    const score = computeNormalizedPnl(10000000, 100000);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('uses custom reference', () => {
    const score = computeNormalizedPnl(50000, 50000);
    expect(score).toBeCloseTo(0.3, 1);
  });
});

describe('computePerformanceScore', () => {
  const baseStats: AccountStats = {
    realizedPnl: 50000,
    numTrades: 50,
    numWins: 35,
    numLosses: 15,
    pnlList: [0, 10000, 20000, 30000, 40000, 50000],
  };

  it('returns zero result for invalid numTrades', () => {
    const result = computePerformanceScore({ ...baseStats, numTrades: -1 });
    expect(result.score).toBe(0);
    expect(result.filtered).toBe(false);
  });

  it('returns zero result for invalid numWins', () => {
    const result = computePerformanceScore({ ...baseStats, numWins: NaN });
    expect(result.score).toBe(0);
  });

  it('returns zero result for invalid numLosses', () => {
    const result = computePerformanceScore({ ...baseStats, numLosses: -5 });
    expect(result.score).toBe(0);
  });

  it('marks non-profitable accounts as filtered', () => {
    const result = computePerformanceScore({
      ...baseStats,
      pnlList: [0, 100, -50], // Ends negative
    });
    expect(result.filtered).toBe(true);
    expect(result.filterReason).toBe('not_profitable');
  });

  it('marks accounts with insufficient data as filtered', () => {
    const result = computePerformanceScore({
      ...baseStats,
      pnlList: [100], // Only one point
    });
    expect(result.filtered).toBe(true);
    expect(result.filterReason).toBe('insufficient_data');
  });

  it('marks accounts with no pnlList as filtered', () => {
    const result = computePerformanceScore({
      ...baseStats,
      pnlList: undefined,
    });
    expect(result.filtered).toBe(true);
    expect(result.filterReason).toBe('insufficient_data');
  });

  it('computes full score when computeFullScore option is true', () => {
    const result = computePerformanceScore(
      { ...baseStats, pnlList: [0, 100, -50] },
      DEFAULT_SCORING_PARAMS,
      { computeFullScore: true }
    );
    expect(result.filtered).toBe(true);
    expect(result.filterReason).toBe('not_profitable');
    // Still computes other scores
    expect(result.details.winRateScore).toBeGreaterThan(0);
    expect(result.details.tradeFreqScore).toBeGreaterThan(0);
  });

  it('returns valid scoring result for good account', () => {
    const result = computePerformanceScore(baseStats);
    expect(result.score).toBeGreaterThan(0);
    expect(result.filtered).toBe(false);
    expect(result.details.stabilityScore).toBeGreaterThan(0);
    expect(result.details.winRateScore).toBeGreaterThan(0);
    expect(result.details.tradeFreqScore).toBe(1.0);
    expect(result.details.normalizedPnl).toBeGreaterThan(0);
  });

  it('includes weighted components in details', () => {
    const result = computePerformanceScore(baseStats);
    const { weightedComponents } = result.details;

    expect(weightedComponents.stability).toBeGreaterThan(0);
    expect(weightedComponents.winRate).toBeGreaterThan(0);
    expect(weightedComponents.tradeFreq).toBeGreaterThan(0);
    expect(weightedComponents.pnl).toBeGreaterThan(0);

    // Sum of weighted components should equal total score
    const sum = weightedComponents.stability + weightedComponents.winRate +
                weightedComponents.tradeFreq + weightedComponents.pnl;
    expect(sum).toBeCloseTo(result.score, 6);
  });

  it('uses custom scoring parameters', () => {
    const customParams = {
      ...DEFAULT_SCORING_PARAMS,
      stabilityWeight: 0.80,
      winRateWeight: 0.10,
      tradeFreqWeight: 0.05,
      pnlWeight: 0.05,
    };
    const result = computePerformanceScore(baseStats, customParams);

    // Stability should dominate with 80% weight
    expect(result.details.weightedComponents.stability).toBeGreaterThan(
      result.details.weightedComponents.winRate
    );
  });

  it('calculates rawWinRate correctly', () => {
    const result = computePerformanceScore({
      ...baseStats,
      numWins: 7,
      numLosses: 3,
    });
    expect(result.details.rawWinRate).toBeCloseTo(0.7, 2);
  });

  it('handles zero wins and losses', () => {
    const result = computePerformanceScore({
      ...baseStats,
      numWins: 0,
      numLosses: 0,
    });
    expect(result.details.rawWinRate).toBe(0);
    expect(result.details.winRateScore).toBe(0);
  });
});

describe('rankAccounts', () => {
  const makeAccount = (address: string, pnl: number, trades = 50): RankableAccount => ({
    address,
    stats: {
      realizedPnl: pnl,
      numTrades: trades,
      numWins: Math.round(trades * 0.7),
      numLosses: trades - Math.round(trades * 0.7),
      pnlList: Array.from({ length: 10 }, (_, i) => (pnl / 10) * i),
    },
  });

  it('ranks accounts by score descending', () => {
    const accounts = [
      makeAccount('0xlow', 10000),
      makeAccount('0xhigh', 100000),
      makeAccount('0xmid', 50000),
    ];
    const ranked = rankAccounts(accounts);

    expect(ranked[0].address).toBe('0xhigh');
    expect(ranked[1].address).toBe('0xmid');
    expect(ranked[2].address).toBe('0xlow');
  });

  it('assigns correct rank numbers', () => {
    const accounts = [
      makeAccount('0xa', 10000),
      makeAccount('0xb', 20000),
      makeAccount('0xc', 30000),
    ];
    const ranked = rankAccounts(accounts);

    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
    expect(ranked[2].rank).toBe(3);
  });

  it('computes weights that sum to 1 for eligible accounts', () => {
    const accounts = [
      makeAccount('0xa', 50000),
      makeAccount('0xb', 50000),
      makeAccount('0xc', 50000),
    ];
    const ranked = rankAccounts(accounts);

    const totalWeight = ranked.reduce((sum, a) => sum + a.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 6);
  });

  it('respects topN option', () => {
    const accounts = [
      makeAccount('0xa', 50000),
      makeAccount('0xb', 40000),
      makeAccount('0xc', 30000),
      makeAccount('0xd', 20000),
    ];
    const ranked = rankAccounts(accounts, DEFAULT_SCORING_PARAMS, { topN: 2 });

    expect(ranked).toHaveLength(2);
    expect(ranked[0].address).toBe('0xa');
    expect(ranked[1].address).toBe('0xb');
  });

  it('excludes filtered accounts from weight calculation', () => {
    const accounts: RankableAccount[] = [
      makeAccount('0xgood', 50000),
      {
        address: '0xbad',
        stats: {
          realizedPnl: 100000,
          numTrades: 50,
          numWins: 35,
          numLosses: 15,
          pnlList: [0, 100, -50], // Non-profitable, will be filtered
        },
      },
    ];
    const ranked = rankAccounts(accounts);

    // The good account should have all the weight
    const good = ranked.find(a => a.address === '0xgood');
    const bad = ranked.find(a => a.address === '0xbad');

    expect(good?.weight).toBeCloseTo(1.0, 6);
    expect(bad?.weight).toBe(0);
  });

  it('preserves isCustom and meta properties', () => {
    const accounts: RankableAccount[] = [
      {
        ...makeAccount('0xcustom', 50000),
        isCustom: true,
        meta: { note: 'test account' },
      },
    ];
    const ranked = rankAccounts(accounts);

    expect(ranked[0].isCustom).toBe(true);
    expect(ranked[0].meta).toEqual({ note: 'test account' });
  });

  it('uses computeFullScore option', () => {
    const accounts: RankableAccount[] = [
      {
        address: '0xfiltered',
        stats: {
          realizedPnl: 50000,
          numTrades: 50,
          numWins: 35,
          numLosses: 15,
          pnlList: [0, 100, -50], // Non-profitable
        },
      },
    ];
    const ranked = rankAccounts(accounts, DEFAULT_SCORING_PARAMS, { computeFullScore: true });

    expect(ranked[0].filtered).toBe(true);
    // Should still have computed other scores
    expect(ranked[0].details.winRateScore).toBeGreaterThan(0);
  });

  it('handles empty accounts array', () => {
    const ranked = rankAccounts([]);
    expect(ranked).toHaveLength(0);
  });
});
