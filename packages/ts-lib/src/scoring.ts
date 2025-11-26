/**
 * Performance Scoring Module
 *
 * Implements a composite performance score for ranking trading accounts.
 * The formula prioritizes:
 * 1. Stability Score - smooth, controlled drawdown profit ability (most important)
 * 2. Win Rate - with progressive penalty for win rate < 60%
 * 3. Trade Count - progressive penalty for > 150 trades per 30 days
 * 4. Realized PnL - tiebreaker for accounts with similar stability scores
 *
 * @module scoring
 */

/**
 * Hyperparameters for the scoring formula.
 */
export interface ScoringParams {
  /**
   * Weight for stability score component (0-1).
   * Default: 0.50 (most important)
   */
  stabilityWeight: number;

  /**
   * Weight for win rate component (0-1).
   * Default: 0.25
   */
  winRateWeight: number;

  /**
   * Weight for trade frequency component (0-1).
   * Default: 0.15
   */
  tradeFreqWeight: number;

  /**
   * Weight for normalized PnL component (0-1).
   * Default: 0.10 (tiebreaker for large accounts)
   */
  pnlWeight: number;

  /**
   * Reference PnL for log normalization.
   * Default: 100000
   */
  pnlReference: number;

  /**
   * Minimum trades required (per 30 days).
   * Default: 3
   */
  minTrades: number;

  /**
   * Maximum trades allowed (per 30 days). Hard filter.
   * Default: 200
   */
  maxTrades: number;

  /**
   * Trade count threshold above which penalties apply (per 30 days).
   * Default: 100
   */
  tradeCountThreshold: number;

  /**
   * Win rate threshold below which penalties apply.
   * Default: 0.60 (60%)
   */
  winRateThreshold: number;

  /**
   * Drawdown tolerance scale for stability score (D0).
   * Lower = stricter. Practical range: 0.15-0.35
   * Default: 0.20
   */
  drawdownTolerance: number;

  /**
   * Downside volatility tolerance scale for stability score (S0).
   * Lower = stricter. Practical range: 0.02-0.05
   * Default: 0.03
   */
  downsideTolerance: number;
}

/**
 * Default scoring parameters
 */
export const DEFAULT_SCORING_PARAMS: ScoringParams = {
  stabilityWeight: 0.50,
  winRateWeight: 0.25,
  tradeFreqWeight: 0.15,
  pnlWeight: 0.10,
  pnlReference: 100000,
  minTrades: 3,
  maxTrades: 200,
  tradeCountThreshold: 100,
  winRateThreshold: 0.60,
  drawdownTolerance: 0.20,   // D0 - strict for BTC volatility
  downsideTolerance: 0.03,   // S0 - moderate tolerance
};

/**
 * PnL time series point - supports multiple formats
 */
export type PnlPoint =
  | number
  | [number, number]
  | [number, string]
  | { timestamp?: number; value?: number | string; pnl?: number | string };

/**
 * Account statistics required for performance scoring.
 */
export interface AccountStats {
  /** Realized PnL over the period (can be negative) */
  realizedPnl: number;

  /** Total number of closed trades */
  numTrades: number;

  /** Number of winning trades */
  numWins: number;

  /** Number of losing trades */
  numLosses: number;

  /** PnL time series for stability score calculation */
  pnlList?: PnlPoint[];
}

/**
 * Result of computing a performance score for an account.
 */
export interface ScoringResult {
  /** Final composite performance score (higher = better) */
  score: number;

  /** Whether account was filtered out */
  filtered: boolean;

  /** Reason for filtering if applicable */
  filterReason?: 'not_profitable' | 'insufficient_data';

  /** Intermediate calculation values for debugging/display */
  details: {
    /** Stability score [0, 1] - from pnlList analysis */
    stabilityScore: number;

    /** Maximum drawdown from PnL series [0, 1] */
    maxDrawdown: number;

    /** Ulcer index (RMS of drawdowns) */
    ulcerIndex: number;

    /** Fraction of up moves [0, 1] */
    upFraction: number;

    /** Downside volatility */
    downsideVolatility: number;

    /** Raw win rate before adjustments */
    rawWinRate: number;

    /** Win rate score after progressive penalty */
    winRateScore: number;

    /** Trade frequency score after progressive penalty */
    tradeFreqScore: number;

    /** Normalized PnL score [0, 1] */
    normalizedPnl: number;

    /** Component scores weighted */
    weightedComponents: {
      stability: number;
      winRate: number;
      tradeFreq: number;
      pnl: number;
    };
  };
}

/**
 * Result of stability score calculation
 */
export interface StabilityResult {
  /** Stability score [0, 1] - higher = smoother, more stable */
  score: number;
  /** Maximum drawdown [0, 1] */
  maxDrawdown: number;
  /** Ulcer index (RMS of drawdowns) */
  ulcerIndex: number;
  /** Fraction of up moves [0, 1] */
  upFraction: number;
  /** Downside volatility (std of negative deltas) */
  downsideVolatility: number;
  /** Whether the account is profitable */
  isProfitable: boolean;
}

/**
 * Computes the Stability Score from a cumulative PnL time series.
 *
 * This score measures how smooth and controlled the profit generation is:
 * - Rewards frequent up moves
 * - Penalizes large drawdowns
 * - Penalizes volatile downside movements
 * - Returns 0 for non-profitable accounts
 *
 * @param pnlList - Array of PnL points in time order
 * @param D0 - Drawdown tolerance scale (0.15-0.35, lower = stricter)
 * @param S0 - Downside volatility tolerance scale (0.02-0.05, lower = stricter)
 * @returns StabilityResult with score and intermediate metrics
 */
export function computeStabilityScore(
  pnlList: PnlPoint[],
  D0: number = 0.20,
  S0: number = 0.03
): StabilityResult {
  const zeroResult: StabilityResult = {
    score: 0,
    maxDrawdown: 0,
    ulcerIndex: 0,
    upFraction: 0,
    downsideVolatility: 0,
    isProfitable: false,
  };

  if (!pnlList || pnlList.length < 2) {
    return zeroResult;
  }

  // Extract numeric PnL values
  const values: number[] = [];
  for (const point of pnlList) {
    let v: number | string | undefined;

    if (Array.isArray(point)) {
      // [timestamp, pnl] - take last element
      v = point[point.length - 1];
    } else if (typeof point === 'object' && point !== null) {
      v = point.pnl ?? point.value;
    } else {
      v = point;
    }

    const parsed = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
      values.push(parsed);
    }
  }

  const n = values.length;
  if (n < 2) {
    return zeroResult;
  }

  // Work with net PnL change (make series start at 0)
  const base = values[0];
  const X = values.map((v) => v - base);

  // If not profitable (final PnL <= initial), return 0
  if (X[X.length - 1] <= 0) {
    return { ...zeroResult, isProfitable: false };
  }

  // Check for no movement
  const xmin = Math.min(...X);
  const xmax = Math.max(...X);
  const span = xmax - xmin;
  if (span <= 0) {
    return zeroResult;
  }

  // Normalize to pseudo-equity in [0, 1]
  const eps = 1e-12;
  const E = X.map((x) => (x - xmin) / (span + eps));

  // Compute step changes (pseudo "returns")
  const deltas: number[] = [];
  for (let i = 1; i < n; i++) {
    deltas.push(E[i] - E[i - 1]);
  }

  // Up-fraction: how often equity moves up
  const upMoves = deltas.filter((d) => d > 0).length;
  const upFraction = upMoves / (n - 1);

  // Downside volatility: std of negative deltas
  const negDeltas = deltas.filter((d) => d < 0);
  let downsideVolatility = 0;
  if (negDeltas.length > 0) {
    const meanSquareNeg = negDeltas.reduce((sum, d) => sum + d * d, 0) / negDeltas.length;
    downsideVolatility = Math.sqrt(meanSquareNeg);
  }

  // Drawdown and Ulcer Index on normalized equity
  let peak = E[0];
  let maxDrawdown = 0;
  let sumDd2 = 0;

  for (const e of E) {
    if (e > peak) {
      peak = e;
    }
    // Drawdown as fraction of peak
    const dd = peak > eps ? (peak - e) / peak : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
    }
    sumDd2 += dd * dd;
  }

  const ulcerIndex = Math.sqrt(sumDd2 / n);

  // Final Stability Score with exponential penalties
  const penaltyDrawdown = Math.exp(-maxDrawdown / D0);
  const penaltyUlcer = Math.exp(-ulcerIndex / D0);
  const penaltySigma = Math.exp(-downsideVolatility / S0);

  const score = upFraction * penaltyDrawdown * penaltyUlcer * penaltySigma;

  return {
    score: Number.isFinite(score) ? score : 0,
    maxDrawdown,
    ulcerIndex,
    upFraction,
    downsideVolatility,
    isProfitable: true,
  };
}

/**
 * Computes progressive win rate penalty for win rates below threshold.
 * 100% win rate returns 0 (filtered out as suspicious).
 *
 * @param winRate - Raw win rate [0, 1]
 * @param threshold - Threshold below which penalties apply (default 0.60)
 * @returns Win rate score [0, 1], or 0 for 100% win rate
 */
export function computeWinRateScore(winRate: number, threshold: number = 0.60): number {
  // Filter out 100% win rate as suspicious
  if (winRate >= 0.999) {
    return 0;
  }

  if (winRate >= threshold) {
    // No penalty above threshold, but cap at 1.0
    return Math.min(1.0, winRate);
  }

  // Progressive penalty below threshold (increased penalties)
  // At threshold: score = threshold (no penalty)
  // At 55%: mild penalty
  // At 50%: moderate penalty
  // At 45%: severe penalty
  // At 40%: very severe penalty
  // Below 35%: extreme penalty

  const deficit = threshold - winRate;

  if (deficit <= 0.05) {
    // 55-60%: mild penalty (0.85x)
    return winRate * 0.85;
  } else if (deficit <= 0.10) {
    // 50-55%: moderate penalty (0.7x)
    return winRate * 0.7;
  } else if (deficit <= 0.15) {
    // 45-50%: severe penalty (0.5x)
    return winRate * 0.5;
  } else if (deficit <= 0.20) {
    // 40-45%: very severe penalty (0.3x)
    return winRate * 0.3;
  } else if (deficit <= 0.25) {
    // 35-40%: extreme penalty (0.15x)
    return winRate * 0.15;
  } else {
    // Below 35%: near zero (0.05x)
    return winRate * 0.05;
  }
}

/**
 * Computes progressive trade frequency penalty.
 * - Minimum 3 trades required (returns 0 if below)
 * - Maximum 200 trades allowed (returns 0 if above)
 * - Progressive penalty for trades > 100
 *
 * @param numTrades - Number of trades in the period
 * @param minTrades - Minimum trades required (default 3)
 * @param maxTrades - Maximum trades allowed (default 200)
 * @param penaltyThreshold - Threshold above which penalties apply (default 100)
 * @returns Trade frequency score [0, 1]
 */
export function computeTradeFreqScore(
  numTrades: number,
  minTrades: number = 3,
  maxTrades: number = 200,
  penaltyThreshold: number = 100
): number {
  // Hard filter: minimum trades required
  if (numTrades < minTrades) {
    return 0;
  }

  // Hard filter: maximum trades exceeded
  if (numTrades > maxTrades) {
    return 0;
  }

  // No penalty if under threshold
  if (numTrades <= penaltyThreshold) {
    return 1.0;
  }

  // Progressive penalty for trades > 100 (up to 200)
  const excess = numTrades - penaltyThreshold;
  const maxExcess = maxTrades - penaltyThreshold; // 100 trades of penalty range

  if (excess <= 25) {
    // 100-125 trades: mild penalty (0.85x)
    return 0.85;
  } else if (excess <= 50) {
    // 125-150 trades: moderate penalty (0.7x)
    return 0.7;
  } else if (excess <= 75) {
    // 150-175 trades: severe penalty (0.5x)
    return 0.5;
  } else {
    // 175-200 trades: very severe penalty (0.3x)
    return 0.3;
  }
}

/**
 * Computes normalized PnL score using log scaling.
 * This gives modest weight to large accounts as a tiebreaker.
 *
 * @param realizedPnl - Realized PnL (can be negative)
 * @param reference - Reference PnL for normalization (default 100000)
 * @returns Normalized score [0, 1]
 */
export function computeNormalizedPnl(realizedPnl: number, reference: number = 100000): number {
  if (!Number.isFinite(realizedPnl) || realizedPnl <= 0) {
    return 0;
  }
  // Log scale: log(1 + pnl/ref) / log(1 + 10)
  // At pnl = ref: score ≈ 0.3
  // At pnl = 10*ref: score ≈ 1.0
  const logScore = Math.log(1 + realizedPnl / reference) / Math.log(11);
  return Math.min(1, Math.max(0, logScore));
}

/**
 * Creates a zero-score result for invalid inputs
 */
function createZeroResult(): ScoringResult {
  return {
    score: 0,
    filtered: false,
    details: {
      stabilityScore: 0,
      maxDrawdown: 0,
      ulcerIndex: 0,
      upFraction: 0,
      downsideVolatility: 0,
      rawWinRate: 0,
      winRateScore: 0,
      tradeFreqScore: 0,
      normalizedPnl: 0,
      weightedComponents: {
        stability: 0,
        winRate: 0,
        tradeFreq: 0,
        pnl: 0,
      },
    },
  };
}

/**
 * Creates a filtered result for accounts that fail criteria
 */
function createFilteredResult(
  reason: 'not_profitable' | 'insufficient_data',
  stabilityResult?: StabilityResult
): ScoringResult {
  return {
    score: 0,
    filtered: true,
    filterReason: reason,
    details: {
      stabilityScore: stabilityResult?.score ?? 0,
      maxDrawdown: stabilityResult?.maxDrawdown ?? 0,
      ulcerIndex: stabilityResult?.ulcerIndex ?? 0,
      upFraction: stabilityResult?.upFraction ?? 0,
      downsideVolatility: stabilityResult?.downsideVolatility ?? 0,
      rawWinRate: 0,
      winRateScore: 0,
      tradeFreqScore: 0,
      normalizedPnl: 0,
      weightedComponents: {
        stability: 0,
        winRate: 0,
        tradeFreq: 0,
        pnl: 0,
      },
    },
  };
}

/**
 * Computes the composite performance score for a single account.
 *
 * Formula (weighted sum):
 * score = stabilityWeight * stabilityScore
 *       + winRateWeight * winRateScore
 *       + tradeFreqWeight * tradeFreqScore
 *       + pnlWeight * normalizedPnl
 *
 * Priority:
 * 1. Stability Score (50%) - most important, measures smooth profit generation
 * 2. Win Rate (25%) - with progressive penalty for < 60%
 * 3. Trade Frequency (15%) - with progressive penalty for > 150 trades
 * 4. Realized PnL (10%) - tiebreaker for large accounts
 *
 * @param stats - Account statistics for the period
 * @param params - Scoring hyperparameters (optional, uses defaults)
 * @param options - Additional options for score computation
 * @param options.computeFullScore - If true, compute full score even when filtered
 * @returns Scoring result with final score, filter status, and intermediate details
 */
export function computePerformanceScore(
  stats: AccountStats,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
  options: { computeFullScore?: boolean } = {}
): ScoringResult {
  const { realizedPnl, numTrades, numWins, numLosses, pnlList } = stats;
  const { computeFullScore = false } = options;

  // Validate inputs
  if (!Number.isFinite(numTrades) || numTrades < 0) {
    return createZeroResult();
  }
  if (!Number.isFinite(numWins) || numWins < 0) {
    return createZeroResult();
  }
  if (!Number.isFinite(numLosses) || numLosses < 0) {
    return createZeroResult();
  }

  // 1. Compute stability score from PnL time series
  const stabilityResult = pnlList && pnlList.length >= 2
    ? computeStabilityScore(pnlList, params.drawdownTolerance, params.downsideTolerance)
    : { score: 0, maxDrawdown: 0, ulcerIndex: 0, upFraction: 0, downsideVolatility: 0, isProfitable: false };

  // Track filtering
  let filtered = false;
  let filterReason: 'not_profitable' | 'insufficient_data' | undefined;

  // Check if account is profitable (based on pnlList)
  if (pnlList && pnlList.length >= 2 && !stabilityResult.isProfitable) {
    filtered = true;
    filterReason = 'not_profitable';
    if (!computeFullScore) {
      return createFilteredResult('not_profitable', stabilityResult);
    }
  }

  // Check for insufficient data
  if (!pnlList || pnlList.length < 2) {
    filtered = true;
    filterReason = 'insufficient_data';
    if (!computeFullScore) {
      return createFilteredResult('insufficient_data');
    }
  }

  // 2. Compute win rate score with progressive penalty
  const rawWinRate = numWins + numLosses > 0
    ? numWins / (numWins + numLosses)
    : 0;
  const winRateScore = computeWinRateScore(rawWinRate, params.winRateThreshold);

  // 3. Compute trade frequency score with progressive penalty
  const tradeFreqScore = computeTradeFreqScore(
    numTrades,
    params.minTrades,
    params.maxTrades,
    params.tradeCountThreshold
  );

  // 4. Compute normalized PnL (tiebreaker)
  const normalizedPnl = computeNormalizedPnl(realizedPnl ?? 0, params.pnlReference);

  // 5. Compute weighted components
  const weightedStability = params.stabilityWeight * stabilityResult.score;
  const weightedWinRate = params.winRateWeight * winRateScore;
  const weightedTradeFreq = params.tradeFreqWeight * tradeFreqScore;
  const weightedPnl = params.pnlWeight * normalizedPnl;

  // 6. Final composite score
  const score = weightedStability + weightedWinRate + weightedTradeFreq + weightedPnl;

  return {
    score: Number.isFinite(score) ? score : 0,
    filtered,
    filterReason,
    details: {
      stabilityScore: stabilityResult.score,
      maxDrawdown: stabilityResult.maxDrawdown,
      ulcerIndex: stabilityResult.ulcerIndex,
      upFraction: stabilityResult.upFraction,
      downsideVolatility: stabilityResult.downsideVolatility,
      rawWinRate,
      winRateScore,
      tradeFreqScore,
      normalizedPnl,
      weightedComponents: {
        stability: weightedStability,
        winRate: weightedWinRate,
        tradeFreq: weightedTradeFreq,
        pnl: weightedPnl,
      },
    },
  };
}

/**
 * Account with address and stats for ranking
 */
export interface RankableAccount {
  address: string;
  stats: AccountStats;
  /** Optional: indicates if this is a user-added custom account */
  isCustom?: boolean;
  /** Optional: any additional metadata to preserve */
  meta?: Record<string, unknown>;
}

/**
 * Ranked account with computed score
 */
export interface RankedAccount {
  address: string;
  score: number;
  rank: number;
  weight: number;
  filtered: boolean;
  filterReason?: string;
  details: ScoringResult['details'];
  isCustom?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Ranks a list of accounts by their performance scores.
 *
 * @param accounts - Array of accounts to rank
 * @param params - Scoring parameters
 * @param options - Ranking options
 * @returns Sorted array of ranked accounts (highest score first)
 */
export function rankAccounts(
  accounts: RankableAccount[],
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
  options: { topN?: number; computeFullScore?: boolean } = {}
): RankedAccount[] {
  const { topN, computeFullScore = false } = options;

  // Score all accounts
  const scored = accounts.map((account) => {
    const result = computePerformanceScore(account.stats, params, { computeFullScore });
    return {
      address: account.address,
      score: result.score,
      rank: 0, // Will be assigned after sorting
      weight: 0, // Will be computed after ranking
      filtered: result.filtered,
      filterReason: result.filterReason,
      details: result.details,
      isCustom: account.isCustom,
      meta: account.meta,
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Assign ranks
  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  // Compute weights for top N (excluding filtered)
  const eligible = scored.filter((a) => !a.filtered);
  const top = topN ? eligible.slice(0, topN) : eligible;
  const sumScores = top.reduce((sum, a) => sum + a.score, 0);

  for (const account of scored) {
    if (top.includes(account) && sumScores > 0) {
      account.weight = account.score / sumScores;
    } else {
      account.weight = 0;
    }
  }

  return topN ? scored.slice(0, topN) : scored;
}
