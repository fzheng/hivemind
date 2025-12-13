/**
 * Setup mock API routes for E2E tests
 *
 * This ensures tests don't hit the real Hyperliquid API which has rate limits.
 * Import and call setupMocks(page) in beforeEach() for tests that need mocked data.
 */

import { Page } from '@playwright/test';
import {
  mockSummary,
  mockFills,
  mockAlphaPoolResponse,
  mockAlphaPoolFills,
  mockConsensusSignals,
  mockPrices,
  mockRefreshStatus,
  mockLastActivity,
} from './mock-data';

export async function setupMocks(page: Page) {
  // Mock summary API (leaderboard data)
  await page.route('**/dashboard/api/summary**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockSummary),
    });
  });

  // Mock legacy fills API
  await page.route('**/dashboard/api/legacy/fills**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fills: mockFills, hasMore: false }),
    });
  });

  // Mock Alpha Pool API
  await page.route('**/dashboard/api/alpha-pool', async (route) => {
    // Exact match for /alpha-pool (not /alpha-pool/*)
    if (route.request().url().endsWith('/alpha-pool') || route.request().url().includes('/alpha-pool?')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAlphaPoolResponse),
      });
    } else {
      await route.continue();
    }
  });

  // Mock Alpha Pool fills API
  await page.route('**/dashboard/api/alpha-pool/fills**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fills: mockAlphaPoolFills, hasMore: false }),
    });
  });

  // Mock Alpha Pool last activity API
  await page.route('**/dashboard/api/alpha-pool/last-activity**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockLastActivity),
    });
  });

  // Mock Alpha Pool refresh status API
  await page.route('**/dashboard/api/alpha-pool/refresh/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockRefreshStatus),
    });
  });

  // Mock Alpha Pool status API
  await page.route('**/dashboard/api/alpha-pool/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_traders: 50,
        selected_count: 10,
        avg_mu: 0.02,
        avg_kappa: 100,
      }),
    });
  });

  // Mock consensus signals API
  await page.route('**/dashboard/api/consensus/signals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ signals: mockConsensusSignals }),
    });
  });

  // Mock prices API
  await page.route('**/dashboard/api/prices**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockPrices),
    });
  });

  // Mock pinned accounts API
  await page.route('**/dashboard/api/pinned-accounts**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accounts: [] }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock subscriptions status API
  await page.route('**/dashboard/api/subscriptions/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        addressesByMethod: { websocket: 8, polling: 2 },
        maxWebSocketSlots: 10,
        availableSlots: 2,
      }),
    });
  });
}

/**
 * Setup minimal mocks for tests that just need the dashboard to load
 */
export async function setupMinimalMocks(page: Page) {
  // Mock prices (needed for header to render)
  await page.route('**/dashboard/api/prices**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockPrices),
    });
  });

  // Mock Alpha Pool (default tab)
  await page.route('**/dashboard/api/alpha-pool', async (route) => {
    if (route.request().url().endsWith('/alpha-pool') || route.request().url().includes('/alpha-pool?')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAlphaPoolResponse),
      });
    } else {
      await route.continue();
    }
  });

  await page.route('**/dashboard/api/alpha-pool/fills**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fills: mockAlphaPoolFills, hasMore: false }),
    });
  });

  await page.route('**/dashboard/api/alpha-pool/refresh/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockRefreshStatus),
    });
  });

  await page.route('**/dashboard/api/consensus/signals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ signals: mockConsensusSignals }),
    });
  });
}
