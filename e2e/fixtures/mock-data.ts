/**
 * Mock data for E2E tests
 *
 * Using mock data prevents hitting the real Hyperliquid API which has rate limits.
 * All tests should use these mocks to ensure consistent, fast, and reliable test runs.
 */

export const mockTraders = [
  {
    address: '0x1234567890123456789012345678901234567890',
    nickname: 'Trader1',
    winRate: 75.5,
    executedOrders: 150,
    realizedPnl: 125000,
    isPinned: false,
    isCustom: false,
    score: 85.2,
  },
  {
    address: '0x2345678901234567890123456789012345678901',
    nickname: 'Trader2',
    winRate: 68.3,
    executedOrders: 89,
    realizedPnl: 78500,
    isPinned: true,
    isCustom: false,
    score: 72.1,
  },
  {
    address: '0x3456789012345678901234567890123456789012',
    nickname: null,
    winRate: 82.1,
    executedOrders: 234,
    realizedPnl: 215000,
    isPinned: false,
    isCustom: false,
    score: 91.4,
  },
];

export const mockHoldings = {
  '0x1234567890123456789012345678901234567890': [
    {
      symbol: 'BTC',
      size: 1.5,
      entryPrice: 95000,
      liquidationPrice: 80000,
      leverage: 10,
      pnl: 2500,
    },
  ],
  '0x2345678901234567890123456789012345678901': [
    {
      symbol: 'ETH',
      size: 25.0,
      entryPrice: 3200,
      liquidationPrice: 2800,
      leverage: 5,
      pnl: -500,
    },
  ],
  '0x3456789012345678901234567890123456789012': [],
};

export const mockFills = [
  {
    id: 1,
    at: new Date().toISOString(),
    address: '0x1234567890123456789012345678901234567890',
    symbol: 'BTC',
    action: 'Increase Long',
    size: 0.5,
    priceUsd: 97500,
    startPosition: 1.0,
    realizedPnlUsd: null,
    hash: '0xabc123',
  },
  {
    id: 2,
    at: new Date(Date.now() - 60000).toISOString(),
    address: '0x2345678901234567890123456789012345678901',
    symbol: 'ETH',
    action: 'Decrease Short',
    size: 5.0,
    priceUsd: 3250,
    startPosition: -30.0,
    realizedPnlUsd: 1250,
    hash: '0xdef456',
  },
];

export const mockAlphaPoolTraders = [
  {
    address: '0xaaaa111122223333444455556666777788889999',
    nickname: 'AlphaTrader1',
    mu: 0.025,
    kappa: 150,
    sigma: 0.08,
    avg_r: 1.8,
    selected: true,
    pnl_curve: [
      { time: Date.now() - 86400000 * 7, value: 100000 },
      { time: Date.now() - 86400000 * 6, value: 102500 },
      { time: Date.now() - 86400000 * 5, value: 105000 },
      { time: Date.now() - 86400000 * 4, value: 103000 },
      { time: Date.now() - 86400000 * 3, value: 108000 },
      { time: Date.now() - 86400000 * 2, value: 112000 },
      { time: Date.now() - 86400000, value: 115000 },
      { time: Date.now(), value: 118000 },
    ],
  },
  {
    address: '0xbbbb222233334444555566667777888899990000',
    nickname: 'AlphaTrader2',
    mu: 0.018,
    kappa: 120,
    sigma: 0.12,
    avg_r: 1.5,
    selected: true,
    pnl_curve: [
      { time: Date.now() - 86400000 * 7, value: 50000 },
      { time: Date.now(), value: 58000 },
    ],
  },
];

export const mockAlphaPoolFills = [
  {
    id: 101,
    at: new Date().toISOString(),
    address: '0xaaaa111122223333444455556666777788889999',
    symbol: 'BTC',
    action: 'Open Long',
    size: 2.0,
    priceUsd: 97800,
    startPosition: 0,
    realizedPnlUsd: null,
    hash: '0xalpha1',
  },
  {
    id: 102,
    at: new Date(Date.now() - 120000).toISOString(),
    address: '0xbbbb222233334444555566667777888899990000',
    symbol: 'ETH',
    action: 'Close Long',
    size: 10.0,
    priceUsd: 3280,
    startPosition: 10.0,
    realizedPnlUsd: 850,
    hash: '0xalpha2',
  },
];

export const mockConsensusSignals = [
  {
    id: 1,
    created_at: new Date().toISOString(),
    symbol: 'BTC',
    direction: 'long',
    confidence: 0.85,
    voters: 4,
    eff_k: 3.2,
    avg_entry: 97500,
    outcome: null,
  },
  {
    id: 2,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    symbol: 'ETH',
    direction: 'short',
    confidence: 0.72,
    voters: 3,
    eff_k: 2.8,
    avg_entry: 3250,
    outcome: { pnl: -150, r_multiple: -0.5 },
  },
];

export const mockPrices = {
  BTC: 97650.50,
  ETH: 3275.25,
};

export const mockRefreshStatus = {
  is_running: false,
  current_step: null,
  progress: 100,
  last_refresh: new Date(Date.now() - 3600000).toISOString(),
};

export const mockSummary = {
  stats: mockTraders,
  holdings: mockHoldings,
  customPinnedCount: 0,
  maxCustomPinned: 3,
};

export const mockAlphaPoolResponse = {
  traders: mockAlphaPoolTraders,
  status: {
    total_traders: 50,
    selected_count: 10,
    last_refresh: new Date(Date.now() - 3600000).toISOString(),
  },
};

export const mockLastActivity = mockAlphaPoolTraders.reduce((acc, trader) => {
  acc[trader.address] = new Date(Date.now() - Math.random() * 3600000).toISOString();
  return acc;
}, {} as Record<string, string>);
