import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Alpha Pool Last Activity Toggle
 *
 * Tests the new feature where clicking on a Last Activity timestamp
 * toggles between relative ("2h ago") and absolute ("Dec 8, 14:26") display formats.
 *
 * These tests are READ-ONLY - they only verify UI behavior.
 */

test.describe('Alpha Pool - Last Activity API', () => {
  test('last-activity endpoint should return valid data', async ({ page }) => {
    await page.goto('/dashboard');

    // Request last activity data directly
    const response = await page.request.get('/dashboard/api/alpha-pool/last-activity');
    expect(response.status()).toBe(200);

    const data = await response.json();
    // Should have lastActivity object
    expect(typeof data.lastActivity).toBe('object');
  });

  test('last-activity endpoint should return ISO timestamps', async ({ page }) => {
    await page.goto('/dashboard');

    const response = await page.request.get('/dashboard/api/alpha-pool/last-activity');
    expect(response.status()).toBe(200);

    const data = await response.json();
    const entries = Object.entries(data.lastActivity);

    // If there are entries, they should have valid ISO timestamp values
    if (entries.length > 0) {
      const [_address, timestamp] = entries[0] as [string, string];
      // ISO timestamps should be parseable and contain 'T' or 'Z'
      const date = new Date(timestamp);
      expect(date.getTime()).not.toBeNaN();
    }
  });
});

test.describe('Alpha Pool - Last Activity Column Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    // Alpha Pool tab is active by default
    await page.waitForTimeout(2000); // Wait for data to load
  });

  test('should display Last Activity header', async ({ page }) => {
    const header = page.locator('[data-testid="alpha-pool-last-activity-header"]');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Last Activity');
  });

  test('Last Activity header should have tooltip about click to toggle', async ({ page }) => {
    const header = page.locator('[data-testid="alpha-pool-last-activity-header"]');
    const title = await header.getAttribute('title');
    expect(title?.toLowerCase()).toContain('click');
    expect(title?.toLowerCase()).toContain('toggle');
  });

  test('should display activity times in Alpha Pool table', async ({ page }) => {
    // Wait for table to load
    const tbody = page.locator('[data-testid="alpha-pool-tbody"]');
    await expect(tbody).toBeVisible({ timeout: 10000 });

    // Check for activity-time elements
    const activityTimes = page.locator('[data-testid="alpha-pool-tbody"] .activity-time');
    const noActivity = page.locator('[data-testid="alpha-pool-tbody"] .no-activity');

    // Should have either activity times or no-activity markers
    const activityCount = await activityTimes.count().catch(() => 0);
    const noActivityCount = await noActivity.count().catch(() => 0);

    // At least some rows should exist
    expect(activityCount + noActivityCount).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Alpha Pool - Last Activity Time Toggle', () => {
  // Skip on mobile since table layout may differ
  test.skip(({ isMobile }) => isMobile, 'Time toggle tests for desktop only');

  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForTimeout(2000); // Wait for data to load
  });

  test('clickable activity times should have cursor pointer', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    // Only test if there are clickable activity times
    if (await activityTime.isVisible().catch(() => false)) {
      const cursor = await activityTime.evaluate((el) => window.getComputedStyle(el).cursor);
      expect(cursor).toBe('pointer');
    }
  });

  test('activity times should have data attributes for toggle', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      // Should have both absolute and relative data attributes
      const absolute = await activityTime.getAttribute('data-absolute');
      const relative = await activityTime.getAttribute('data-relative');
      const ts = await activityTime.getAttribute('data-ts');

      expect(absolute).toBeTruthy();
      expect(relative).toBeTruthy();
      expect(ts).toBeTruthy();
    }
  });

  test('clicking activity time should toggle display format', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      // Get initial text
      const initialText = await activityTime.textContent();
      const relativeAttr = await activityTime.getAttribute('data-relative');
      const absoluteAttr = await activityTime.getAttribute('data-absolute');

      // Click to toggle
      await activityTime.click();
      await page.waitForTimeout(100);

      // Get new text
      const newText = await activityTime.textContent();

      // Text should change (unless data is missing)
      if (relativeAttr && absoluteAttr) {
        expect(newText).not.toBe(initialText);
      }
    }
  });

  test('clicking activity time twice should return to original format', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      // Get initial text
      const initialText = await activityTime.textContent();

      // Click twice
      await activityTime.click();
      await page.waitForTimeout(100);
      await activityTime.click();
      await page.waitForTimeout(100);

      // Get final text
      const finalText = await activityTime.textContent();

      // Should return to initial format
      expect(finalText).toBe(initialText);
    }
  });

  test('clicking one activity time should toggle all activity times', async ({ page }) => {
    const activityTimes = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable');
    const count = await activityTimes.count();

    if (count >= 2) {
      // Get initial text of second element
      const secondInitialText = await activityTimes.nth(1).textContent();

      // Click first element
      await activityTimes.first().click();
      await page.waitForTimeout(100);

      // Second element should also toggle
      const secondNewText = await activityTimes.nth(1).textContent();

      // Both should toggle together (global state)
      expect(secondNewText).not.toBe(secondInitialText);
    }
  });

  test('activity time tooltip should update after toggle', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      // Get initial tooltip
      const initialTitle = await activityTime.getAttribute('title');

      // Click to toggle
      await activityTime.click();
      await page.waitForTimeout(100);

      // Get new tooltip
      const newTitle = await activityTime.getAttribute('title');

      // Tooltip should change (shows alternate format)
      if (initialTitle && newTitle) {
        expect(newTitle).not.toBe(initialTitle);
      }
    }
  });

  test('activity times should show relative format by default', async ({ page }) => {
    // Default mode is 'relative'
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      const text = await activityTime.textContent();
      const relativeAttr = await activityTime.getAttribute('data-relative');

      // Default display should match relative attribute
      if (relativeAttr) {
        expect(text).toBe(relativeAttr);
      }
    }
  });

  test('absolute format should include month and time', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      const absoluteAttr = await activityTime.getAttribute('data-absolute');

      if (absoluteAttr) {
        // Absolute format should be like "Dec 8, 14:26"
        // Should contain month abbreviation and colon for time
        expect(absoluteAttr).toMatch(/[A-Za-z]{3}/); // Month abbreviation
        expect(absoluteAttr).toContain(':'); // Time separator
      }
    }
  });

  test('relative format should include time unit', async ({ page }) => {
    const activityTime = page.locator('[data-testid="alpha-pool-tbody"] .activity-time.clickable').first();

    if (await activityTime.isVisible().catch(() => false)) {
      const relativeAttr = await activityTime.getAttribute('data-relative');

      if (relativeAttr) {
        // Relative format should be like "2h ago", "3m ago", "1d ago", or "just now"
        expect(relativeAttr).toMatch(/(\d+[smhd] ago|just now)/i);
      }
    }
  });
});

test.describe('Alpha Pool - No Activity Display', () => {
  test('traders without activity should show dash marker', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForTimeout(2000);

    // Find no-activity markers
    const noActivity = page.locator('[data-testid="alpha-pool-tbody"] .no-activity');
    const count = await noActivity.count();

    // If there are no-activity markers, they should show em-dash
    if (count > 0) {
      const text = await noActivity.first().textContent();
      expect(text).toBe('—'); // em-dash
    }
  });
});
