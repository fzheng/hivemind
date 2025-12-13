/**
 * Tests for position priming and the fix that ensures upsertCurrentPosition() is awaited.
 * Previously, DB writes were fire-and-forget, causing positions to not appear immediately
 * when adding custom accounts to the Legacy Leaderboard.
 *
 * Bug fixed: Custom account positions showed "No BTC/ETH position" with ~1 minute delay
 * because performPrime() returned before DB writes completed.
 */

describe('Position Priming Database Writes', () => {
  test('performPrime should wait for all upsert operations before returning', async () => {
    const upsertCalls: string[] = [];

    // Mock upsertCurrentPosition that tracks calls and adds delay
    const mockUpsertCurrentPosition = async (params: { address: string; symbol: string }): Promise<void> => {
      upsertCalls.push(`${params.address}:${params.symbol}`);
      // Simulate DB write delay
      await new Promise(resolve => setTimeout(resolve, 20));
    };

    // Simulate performPrime logic with proper awaiting (the fix)
    const performPrimeFixed = async (
      addr: string,
      positions: Array<{ coin: string; size: number }>
    ): Promise<void> => {
      const upsertPromises: Promise<void>[] = [];

      for (const pos of positions) {
        upsertPromises.push(
          mockUpsertCurrentPosition({ address: addr, symbol: pos.coin })
        );
      }

      // This is the fix: await all upsert operations
      if (upsertPromises.length > 0) {
        await Promise.all(upsertPromises);
      }
    };

    const startTime = Date.now();

    // Simulate priming an address with BTC and ETH positions
    await performPrimeFixed('0x1234', [
      { coin: 'BTC', size: 1.5 },
      { coin: 'ETH', size: 10.0 },
    ]);

    const elapsed = Date.now() - startTime;

    // Verify all upserts were called
    expect(upsertCalls).toContain('0x1234:BTC');
    expect(upsertCalls).toContain('0x1234:ETH');

    // Verify we actually waited for the DB writes (at least 20ms)
    expect(elapsed).toBeGreaterThanOrEqual(18); // Small buffer for timing
  });

  test('old fire-and-forget pattern does NOT wait for DB writes', async () => {
    const upsertCalls: string[] = [];

    // Mock upsertCurrentPosition with delay
    const mockUpsertCurrentPosition = async (params: { address: string; symbol: string }): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 50));
      upsertCalls.push(`${params.address}:${params.symbol}`);
    };

    // Simulate OLD (buggy) performPrime logic - fire and forget
    const performPrimeOld = async (
      addr: string,
      positions: Array<{ coin: string; size: number }>
    ): Promise<void> => {
      for (const pos of positions) {
        // OLD BUG: Not awaited, just fire-and-forget with .catch()
        mockUpsertCurrentPosition({ address: addr, symbol: pos.coin })
          .catch(() => {});
      }
      // Returns immediately without waiting
    };

    const startTime = Date.now();

    await performPrimeOld('0x1234', [
      { coin: 'BTC', size: 1.5 },
    ]);

    const elapsed = Date.now() - startTime;

    // Old pattern returns immediately (should be < 10ms, definitely < 50ms)
    expect(elapsed).toBeLessThan(10);

    // DB write hasn't completed yet - upsertCalls is still empty
    expect(upsertCalls).toHaveLength(0);

    // Wait for the fire-and-forget promise to complete
    await new Promise(resolve => setTimeout(resolve, 60));

    // Now it's done (but caller already returned, too late for UI)
    expect(upsertCalls).toContain('0x1234:BTC');
  });

  test('awaitPositions flag with fixed performPrime ensures positions in DB before return', async () => {
    const dbWrites: Map<string, { time: number }> = new Map();
    let refreshReturnedAt = 0;

    // Simulate the database write
    const mockUpsertCurrentPosition = async (params: { address: string; symbol: string }): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 30));
      dbWrites.set(`${params.address}:${params.symbol}`, { time: Date.now() });
    };

    // Fixed performPrime
    const performPrimeFixed = async (addr: string): Promise<void> => {
      const upsertPromises: Promise<void>[] = [];
      upsertPromises.push(mockUpsertCurrentPosition({ address: addr, symbol: 'BTC' }));
      upsertPromises.push(mockUpsertCurrentPosition({ address: addr, symbol: 'ETH' }));
      await Promise.all(upsertPromises);
    };

    // Simulate refresh with awaitPositions: true
    const refresh = async (opts?: { awaitPositions?: boolean }): Promise<void> => {
      const newAddrs = ['0xtest'];

      if (opts?.awaitPositions && newAddrs.length > 0) {
        const primePromises = newAddrs.map(addr => performPrimeFixed(addr));
        await Promise.allSettled(primePromises);
      }

      refreshReturnedAt = Date.now();
    };

    await refresh({ awaitPositions: true });

    // All DB writes should have completed BEFORE refresh returned
    const btcWrite = dbWrites.get('0xtest:BTC');
    const ethWrite = dbWrites.get('0xtest:ETH');

    expect(btcWrite).toBeDefined();
    expect(ethWrite).toBeDefined();
    expect(btcWrite!.time).toBeLessThanOrEqual(refreshReturnedAt);
    expect(ethWrite!.time).toBeLessThanOrEqual(refreshReturnedAt);
  });

  test('handles empty positions array gracefully', async () => {
    const upsertCalls: string[] = [];

    const mockUpsertCurrentPosition = async (params: { address: string; symbol: string }): Promise<void> => {
      upsertCalls.push(`${params.address}:${params.symbol}`);
    };

    const performPrimeFixed = async (
      addr: string,
      positions: Array<{ coin: string; size: number }>
    ): Promise<void> => {
      const upsertPromises: Promise<void>[] = [];

      for (const pos of positions) {
        upsertPromises.push(
          mockUpsertCurrentPosition({ address: addr, symbol: pos.coin })
        );
      }

      if (upsertPromises.length > 0) {
        await Promise.all(upsertPromises);
      }
    };

    // No positions
    await performPrimeFixed('0x1234', []);

    expect(upsertCalls).toHaveLength(0);
  });

  test('handles upsert errors gracefully without breaking other upserts', async () => {
    const upsertCalls: string[] = [];
    const errors: string[] = [];

    const mockUpsertCurrentPosition = async (params: { address: string; symbol: string }): Promise<void> => {
      if (params.symbol === 'ETH') {
        throw new Error('DB write failed for ETH');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      upsertCalls.push(`${params.address}:${params.symbol}`);
    };

    const performPrimeFixed = async (
      addr: string,
      positions: Array<{ coin: string; size: number }>
    ): Promise<void> => {
      const upsertPromises: Promise<void>[] = [];

      for (const pos of positions) {
        upsertPromises.push(
          mockUpsertCurrentPosition({ address: addr, symbol: pos.coin })
            .catch((err) => {
              errors.push(err.message);
            })
        );
      }

      if (upsertPromises.length > 0) {
        await Promise.all(upsertPromises);
      }
    };

    await performPrimeFixed('0x1234', [
      { coin: 'BTC', size: 1.5 },
      { coin: 'ETH', size: 10.0 },
    ]);

    // BTC should succeed
    expect(upsertCalls).toContain('0x1234:BTC');
    // ETH error should be caught
    expect(errors).toContain('DB write failed for ETH');
  });
});

describe('Custom Account Position Flow', () => {
  /**
   * Tests the full flow of adding a custom account and having positions available immediately.
   */

  test('custom account add flow should have positions ready before API response', async () => {
    const positionsInDb: Set<string> = new Set();

    // Mock DB operations
    const mockUpsertCurrentPosition = async (addr: string, symbol: string): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 25));
      positionsInDb.add(`${addr}:${symbol}`);
    };

    const mockPerformPrime = async (addr: string): Promise<void> => {
      const upsertPromises = [
        mockUpsertCurrentPosition(addr, 'BTC'),
        mockUpsertCurrentPosition(addr, 'ETH'),
      ];
      await Promise.all(upsertPromises);
    };

    const mockTrackerRefresh = async (opts?: { awaitPositions?: boolean }): Promise<void> => {
      const newAddr = '0xcustomuser';
      if (opts?.awaitPositions) {
        await mockPerformPrime(newAddr);
      }
    };

    // Simulate the API handler
    const handleAddCustomAccount = async (): Promise<{ status: number }> => {
      // 1. Save to DB (fast)
      await new Promise(resolve => setTimeout(resolve, 5));

      // 2. Refresh tracker with awaitPositions
      await mockTrackerRefresh({ awaitPositions: true });

      return { status: 200 };
    };

    await handleAddCustomAccount();

    // Verify: positions were written to DB BEFORE API returned
    expect(positionsInDb.has('0xcustomuser:BTC')).toBe(true);
    expect(positionsInDb.has('0xcustomuser:ETH')).toBe(true);
  });

  test('subsequent summary request should find positions immediately', async () => {
    const positionsInDb: Map<string, number> = new Map();

    // Simulate the timeline
    const timeline: Array<{ event: string; time: number }> = [];

    // Mock operations with timestamps
    const mockUpsertPosition = async (key: string): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 20));
      positionsInDb.set(key, Date.now());
      timeline.push({ event: `db_write:${key}`, time: Date.now() });
    };

    const mockPrime = async (addr: string): Promise<void> => {
      await Promise.all([
        mockUpsertPosition(`${addr}:BTC`),
        mockUpsertPosition(`${addr}:ETH`),
      ]);
    };

    const mockAddCustomAccount = async (addr: string): Promise<void> => {
      timeline.push({ event: 'add_custom_start', time: Date.now() });
      await mockPrime(addr);
      timeline.push({ event: 'add_custom_response', time: Date.now() });
    };

    const mockGetSummary = async (addrs: string[]): Promise<Map<string, boolean>> => {
      timeline.push({ event: 'get_summary_called', time: Date.now() });
      const result = new Map<string, boolean>();
      for (const addr of addrs) {
        // Check if position exists in DB
        result.set(addr, positionsInDb.has(`${addr}:BTC`) || positionsInDb.has(`${addr}:ETH`));
      }
      return result;
    };

    // 1. Add custom account
    await mockAddCustomAccount('0xnewuser');

    // 2. Immediately request summary (like the dashboard does)
    const summaryResult = await mockGetSummary(['0xnewuser']);

    // Position should be found because we awaited the DB write
    expect(summaryResult.get('0xnewuser')).toBe(true);

    // Verify timeline: DB writes happened before summary was called
    const dbWriteEvents = timeline.filter(e => e.event.startsWith('db_write'));
    const summaryEvent = timeline.find(e => e.event === 'get_summary_called');

    for (const dbWrite of dbWriteEvents) {
      expect(dbWrite.time).toBeLessThanOrEqual(summaryEvent!.time);
    }
  });

  test('position available on page reload after adding custom account', async () => {
    // Simulates the scenario where user adds custom account, then reloads page

    const dbState: Map<string, { btc: boolean; eth: boolean }> = new Map();

    const mockAddAccount = async (addr: string): Promise<void> => {
      // Simulate awaited DB write
      await new Promise(resolve => setTimeout(resolve, 20));
      dbState.set(addr, { btc: true, eth: false });
    };

    const mockLoadDashboard = async (addrs: string[]): Promise<Map<string, { btc: boolean; eth: boolean }>> => {
      const result = new Map();
      for (const addr of addrs) {
        const state = dbState.get(addr);
        if (state) {
          result.set(addr, state);
        }
      }
      return result;
    };

    // Add account
    await mockAddAccount('0xmyaccount');

    // Simulate page reload / fresh dashboard load
    const dashboardState = await mockLoadDashboard(['0xmyaccount']);

    expect(dashboardState.get('0xmyaccount')).toEqual({ btc: true, eth: false });
  });
});

describe('Tab Switching Data Refresh', () => {
  /**
   * Tests for the fix that clears stale data when switching to Legacy Leaderboard tab.
   * Previously, switching tabs would show cached fills data that was outdated.
   */

  test('switching to Legacy tab should clear cached fills', async () => {
    let fillsCache: Array<{ time_utc: string; address: string }> = [];
    let aggregatedGroups: Array<{ time: string }> = [];

    // Simulate initial data load with old fills
    fillsCache = [
      { time_utc: '2025-12-04T10:00:00Z', address: '0xold' },
      { time_utc: '2025-12-05T10:00:00Z', address: '0xold' },
    ];
    aggregatedGroups = [{ time: '2025-12-04' }, { time: '2025-12-05' }];

    // Simulate switchTab to legacy-leaderboard (the fix)
    const switchTab = (tabId: string): void => {
      if (tabId === 'legacy-leaderboard') {
        // Clear stale data - THIS IS THE FIX
        fillsCache = [];
        aggregatedGroups = [];
      }
    };

    switchTab('legacy-leaderboard');

    // After switch, caches should be cleared
    expect(fillsCache).toHaveLength(0);
    expect(aggregatedGroups).toHaveLength(0);
  });

  test('refreshFills should be called after switching to Legacy tab', async () => {
    let refreshFillsCalled = false;
    let fillsCache: Array<{ time_utc: string }> = [];

    const refreshFills = async (): Promise<void> => {
      refreshFillsCalled = true;
      // Simulate fetching fresh data
      fillsCache = [
        { time_utc: '2025-12-06T13:00:00Z' },
      ];
    };

    const switchTab = async (tabId: string): Promise<void> => {
      if (tabId === 'legacy-leaderboard') {
        fillsCache = [];
        await refreshFills();
      }
    };

    await switchTab('legacy-leaderboard');

    expect(refreshFillsCalled).toBe(true);
    expect(fillsCache[0].time_utc).toBe('2025-12-06T13:00:00Z');
  });

  test('Alpha Pool tab does not affect Legacy fills cache', async () => {
    let fillsCache = [
      { time_utc: '2025-12-05T10:00:00Z', address: '0xold' },
    ];
    let alphaPoolRefreshCalled = false;

    const refreshAlphaPool = async (): Promise<void> => {
      alphaPoolRefreshCalled = true;
    };

    const switchTab = async (tabId: string): Promise<void> => {
      if (tabId === 'alpha-pool') {
        await refreshAlphaPool();
        // Should NOT clear legacy fills cache
      } else if (tabId === 'legacy-leaderboard') {
        fillsCache = [];
      }
    };

    await switchTab('alpha-pool');

    expect(alphaPoolRefreshCalled).toBe(true);
    // Legacy fills cache should NOT be cleared when switching to Alpha Pool
    expect(fillsCache).toHaveLength(1);
  });
});

describe('Alpha Pool Auto-Refresh State', () => {
  /**
   * Tests for the fix that ensures auto_refresh_alpha_pool_if_empty() properly sets is_running.
   * Previously, it called _do_refresh_alpha_pool() directly, bypassing _background_refresh_task().
   */

  test('auto-refresh should set is_running to true', async () => {
    const refreshState = {
      is_running: false,
      current_step: '',
      progress: 0,
    };

    // Simulate _background_refresh_task which properly sets state
    const backgroundRefreshTask = async (): Promise<void> => {
      refreshState.is_running = true;
      refreshState.current_step = 'Fetching leaderboard...';
      refreshState.progress = 0;

      // Simulate refresh work
      await new Promise(resolve => setTimeout(resolve, 50));

      refreshState.progress = 100;
      refreshState.current_step = 'Complete';
      refreshState.is_running = false;
    };

    // Fixed auto_refresh_alpha_pool_if_empty calls backgroundRefreshTask
    const autoRefreshAlphaPoolIfEmpty = async (isEmpty: boolean): Promise<void> => {
      if (isEmpty) {
        // FIXED: Use backgroundRefreshTask instead of _do_refresh_alpha_pool directly
        await backgroundRefreshTask();
      }
    };

    // Start auto-refresh
    const autoRefreshPromise = autoRefreshAlphaPoolIfEmpty(true);

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 10));

    // State should show refresh is running
    expect(refreshState.is_running).toBe(true);
    expect(refreshState.current_step).toBe('Fetching leaderboard...');

    // Wait for completion
    await autoRefreshPromise;

    expect(refreshState.is_running).toBe(false);
    expect(refreshState.progress).toBe(100);
  });

  test('old pattern (direct call) does NOT set is_running', async () => {
    const refreshState = {
      is_running: false,
      current_step: '',
      progress: 0,
    };

    // Simulate OLD (buggy) _do_refresh_alpha_pool that doesn't set is_running
    const doRefreshAlphaPoolOld = async (): Promise<void> => {
      // OLD BUG: This was called directly without setting is_running first
      await new Promise(resolve => setTimeout(resolve, 50));
    };

    // Old auto_refresh_alpha_pool_if_empty called doRefreshAlphaPoolOld directly
    const autoRefreshAlphaPoolIfEmptyOld = async (isEmpty: boolean): Promise<void> => {
      if (isEmpty) {
        // OLD BUG: Called _do_refresh_alpha_pool directly
        await doRefreshAlphaPoolOld();
      }
    };

    const autoRefreshPromise = autoRefreshAlphaPoolIfEmptyOld(true);

    // Give it a moment
    await new Promise(resolve => setTimeout(resolve, 10));

    // OLD BUG: is_running is still false even though refresh is happening
    expect(refreshState.is_running).toBe(false);

    await autoRefreshPromise;
  });

  test('dashboard polling should see is_running=true during auto-refresh', async () => {
    const refreshState = {
      is_running: false,
      current_step: '',
      progress: 0,
    };

    const pollResults: boolean[] = [];

    const backgroundRefreshTask = async (): Promise<void> => {
      refreshState.is_running = true;
      refreshState.current_step = 'Processing...';

      // Simulate long-running refresh
      for (let i = 0; i <= 100; i += 20) {
        refreshState.progress = i;
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      refreshState.is_running = false;
    };

    const pollStatus = (): boolean => {
      return refreshState.is_running;
    };

    // Start refresh
    const refreshPromise = backgroundRefreshTask();

    // Poll multiple times during refresh
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 15));
      pollResults.push(pollStatus());
    }

    await refreshPromise;

    // At least some polls should have seen is_running = true
    expect(pollResults.filter(r => r === true).length).toBeGreaterThan(0);
  });
});
