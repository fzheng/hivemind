/**
 * Tests for utility functions
 * Covers formatting, normalization, and helper utilities
 */

import {
  normalizeAddress,
  clamp,
  nowIso,
  sleep,
  fetchWithRetry,
} from '../packages/ts-lib/src/utils';

// Mock global fetch for fetchWithRetry tests
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('clamp', () => {
  test('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test('returns min when value is below range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  test('returns max when value is above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test('handles edge case at min boundary', () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  test('handles edge case at max boundary', () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  test('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(0, -10, -1)).toBe(-1);
    expect(clamp(-15, -10, -1)).toBe(-10);
  });

  test('handles fractional values', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-0.1, 0, 1)).toBe(0);
    expect(clamp(1.5, 0, 1)).toBe(1);
  });
});

describe('nowIso', () => {
  test('returns ISO 8601 formatted string', () => {
    const result = nowIso();
    // ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('returns current time (within 1 second)', () => {
    const before = Date.now();
    const result = nowIso();
    const after = Date.now();
    const resultTime = new Date(result).getTime();
    expect(resultTime).toBeGreaterThanOrEqual(before);
    expect(resultTime).toBeLessThanOrEqual(after);
  });
});

describe('sleep', () => {
  test('resolves after specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow some tolerance for timing
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(150);
  });

  test('resolves immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('returns data on successful fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const result = await fetchWithRetry('https://api.test.com', {});
    expect(result).toEqual({ data: 'test' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('retries on HTTP error and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: 'success' }),
      });

    const result = await fetchWithRetry(
      'https://api.test.com',
      {},
      { retries: 2, baseDelayMs: 10 }
    );
    expect(result).toEqual({ data: 'success' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('retries on network error and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: 'recovered' }),
      });

    const result = await fetchWithRetry(
      'https://api.test.com',
      {},
      { retries: 2, baseDelayMs: 10 }
    );
    expect(result).toEqual({ data: 'recovered' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws after exhausting all retries', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      fetchWithRetry('https://api.test.com', {}, { retries: 2, baseDelayMs: 10 })
    ).rejects.toThrow('HTTP 500');
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('uses default retry count when not specified', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      fetchWithRetry('https://api.test.com', {}, { baseDelayMs: 10 })
    ).rejects.toThrow('HTTP 503');
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries (default)
  });

  test('passes request init options to fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchWithRetry('https://api.test.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    });

    expect(mockFetch).toHaveBeenCalledWith('https://api.test.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    });
  });

  test('uses exponential backoff between retries', async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    // Track setTimeout calls
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number) => {
      delays.push(delay || 0);
      return originalSetTimeout(fn, 1) as any; // Execute immediately for test speed
    });

    mockFetch
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

    await fetchWithRetry(
      'https://api.test.com',
      {},
      { retries: 2, baseDelayMs: 100 }
    );

    // Delays should be exponential: 100 * 2^0 = 100, 100 * 2^1 = 200
    expect(delays).toContain(100);
    expect(delays).toContain(200);

    jest.restoreAllMocks();
  });
});

describe('normalizeAddress', () => {
  test('converts uppercase address to lowercase', () => {
    const result = normalizeAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
    expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  test('keeps lowercase address unchanged', () => {
    const result = normalizeAddress('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  test('handles mixed case', () => {
    const result = normalizeAddress('0xAbCdEf1234567890AbCdEf1234567890AbCdEf12');
    expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });
});

// Dashboard formatting utilities (mirrors dashboard.js functions)
describe('Dashboard Formatters', () => {
  // Format price for display (e.g., $97,234.56)
  function fmtPrice(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return '$' + value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  describe('fmtPrice', () => {
    test('formats integer price', () => {
      expect(fmtPrice(95000)).toMatch(/\$95,000\.00/);
    });

    test('formats decimal price', () => {
      expect(fmtPrice(97234.56)).toMatch(/\$97,234\.56/);
    });

    test('returns dash for null', () => {
      expect(fmtPrice(null)).toBe('—');
    });

    test('returns dash for undefined', () => {
      expect(fmtPrice(undefined)).toBe('—');
    });

    test('returns dash for NaN', () => {
      expect(fmtPrice(NaN)).toBe('—');
    });

    test('returns dash for Infinity', () => {
      expect(fmtPrice(Infinity)).toBe('—');
    });

    test('formats small price', () => {
      expect(fmtPrice(0.99)).toMatch(/\$0\.99/);
    });

    test('formats large price', () => {
      const result = fmtPrice(1234567.89);
      expect(result).toMatch(/\$1,234,567\.89/);
    });
  });

  // Format percent (e.g., 75.5%)
  function fmtPercent(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    return `${(value * 100).toFixed(1)}%`;
  }

  describe('fmtPercent', () => {
    test('formats decimal as percentage', () => {
      expect(fmtPercent(0.755)).toBe('75.5%');
    });

    test('formats 100%', () => {
      expect(fmtPercent(1)).toBe('100.0%');
    });

    test('formats 0%', () => {
      expect(fmtPercent(0)).toBe('0.0%');
    });

    test('returns N/A for null', () => {
      expect(fmtPercent(null)).toBe('N/A');
    });

    test('returns N/A for undefined', () => {
      expect(fmtPercent(undefined)).toBe('N/A');
    });

    test('returns N/A for NaN', () => {
      expect(fmtPercent(NaN)).toBe('N/A');
    });

    test('handles values over 100%', () => {
      expect(fmtPercent(1.5)).toBe('150.0%');
    });

    test('handles negative values', () => {
      expect(fmtPercent(-0.25)).toBe('-25.0%');
    });
  });

  // Format USD short (e.g., +$1.5K, -$2.3M)
  function fmtUsdShort(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return 'N/A';
    if (value === 0) return '$0';
    const sign = value > 0 ? '+' : '-';
    const abs = Math.abs(value);
    const formatter = (num: number, suffix: string) =>
      `${sign}$${num.toFixed(num >= 10 ? 1 : 2)}${suffix}`;
    if (abs >= 1e9) return formatter(abs / 1e9, 'B');
    if (abs >= 1e6) return formatter(abs / 1e6, 'M');
    if (abs >= 1e3) return formatter(abs / 1e3, 'K');
    return `${sign}$${abs.toFixed(0)}`;
  }

  describe('fmtUsdShort', () => {
    test('formats zero', () => {
      expect(fmtUsdShort(0)).toBe('$0');
    });

    test('formats small positive value', () => {
      expect(fmtUsdShort(500)).toBe('+$500');
    });

    test('formats small negative value', () => {
      expect(fmtUsdShort(-500)).toBe('-$500');
    });

    test('formats thousands with K suffix', () => {
      expect(fmtUsdShort(1500)).toBe('+$1.50K');
      expect(fmtUsdShort(15000)).toBe('+$15.0K');
    });

    test('formats millions with M suffix', () => {
      expect(fmtUsdShort(1500000)).toBe('+$1.50M');
      expect(fmtUsdShort(15000000)).toBe('+$15.0M');
    });

    test('formats billions with B suffix', () => {
      expect(fmtUsdShort(1500000000)).toBe('+$1.50B');
    });

    test('formats negative thousands', () => {
      expect(fmtUsdShort(-2500)).toBe('-$2.50K');
    });

    test('formats negative millions', () => {
      expect(fmtUsdShort(-2500000)).toBe('-$2.50M');
    });

    test('returns N/A for null', () => {
      expect(fmtUsdShort(null)).toBe('N/A');
    });

    test('returns N/A for undefined', () => {
      expect(fmtUsdShort(undefined)).toBe('N/A');
    });

    test('returns N/A for NaN', () => {
      expect(fmtUsdShort(NaN)).toBe('N/A');
    });
  });

  // Short address (e.g., 0x1234...5678)
  function shortAddress(address: string | null | undefined): string {
    if (!address) return '';
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  describe('shortAddress', () => {
    test('shortens full address', () => {
      const result = shortAddress('0x1234567890abcdef1234567890abcdef12345678');
      expect(result).toBe('0x1234…5678');
    });

    test('returns empty string for null', () => {
      expect(shortAddress(null)).toBe('');
    });

    test('returns empty string for undefined', () => {
      expect(shortAddress(undefined)).toBe('');
    });

    test('returns empty string for empty string', () => {
      expect(shortAddress('')).toBe('');
    });
  });

  // Format time (HH:MM:SS)
  function fmtTime(ts: string | number | Date): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  describe('fmtTime', () => {
    test('formats ISO string', () => {
      const result = fmtTime('2025-01-15T14:30:45Z');
      // Result depends on locale, just verify it contains time components
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    test('formats Date object', () => {
      const date = new Date('2025-01-15T14:30:45Z');
      const result = fmtTime(date);
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    test('formats timestamp number', () => {
      const timestamp = new Date('2025-01-15T14:30:45Z').getTime();
      const result = fmtTime(timestamp);
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });
  });

  // Format score
  function fmtScore(score: number | null | undefined): string {
    if (score == null || !Number.isFinite(score)) return '—';
    if (score === 0) return '0';
    if (Math.abs(score) >= 100) return score.toFixed(1);
    if (Math.abs(score) >= 1) return score.toFixed(2);
    return score.toFixed(4);
  }

  describe('fmtScore', () => {
    test('formats zero', () => {
      expect(fmtScore(0)).toBe('0');
    });

    test('formats small decimal', () => {
      expect(fmtScore(0.1234)).toBe('0.1234');
      expect(fmtScore(0.0001)).toBe('0.0001');
    });

    test('formats medium value', () => {
      expect(fmtScore(12.345)).toBe('12.35');
      expect(fmtScore(1.5)).toBe('1.50');
    });

    test('formats large value', () => {
      expect(fmtScore(123.456)).toBe('123.5');
      expect(fmtScore(1000)).toBe('1000.0');
    });

    test('returns dash for null', () => {
      expect(fmtScore(null)).toBe('—');
    });

    test('returns dash for undefined', () => {
      expect(fmtScore(undefined)).toBe('—');
    });

    test('returns dash for NaN', () => {
      expect(fmtScore(NaN)).toBe('—');
    });

    test('handles negative values', () => {
      expect(fmtScore(-0.5)).toBe('-0.5000');
      expect(fmtScore(-50)).toBe('-50.00');
      expect(fmtScore(-500)).toBe('-500.0');
    });
  });
});

describe('Action Label Formatting', () => {
  function formatActionLabel(fill: { action?: string; side?: string }): string {
    const action = fill.action ? String(fill.action).toLowerCase() : '';
    const map: Record<string, string> = {
      'open long': 'OPEN LONG',
      'increase long': 'ADD LONG',
      'close long (close all)': 'CLOSE LONG',
      'decrease long': 'CLOSE LONG',
      'open short': 'OPEN SHORT',
      'increase short': 'ADD SHORT',
      'close short (close all)': 'CLOSE SHORT',
      'decrease short': 'CLOSE SHORT',
    };
    if (map[action]) return map[action];
    if (fill.side === 'buy') return 'OPEN LONG';
    if (fill.side === 'sell') return 'OPEN SHORT';
    return action ? action.toUpperCase() : 'TRADE';
  }

  test('maps Open Long', () => {
    expect(formatActionLabel({ action: 'Open Long' })).toBe('OPEN LONG');
  });

  test('maps Increase Long to ADD LONG', () => {
    expect(formatActionLabel({ action: 'Increase Long' })).toBe('ADD LONG');
  });

  test('maps Decrease Long to CLOSE LONG', () => {
    expect(formatActionLabel({ action: 'Decrease Long' })).toBe('CLOSE LONG');
  });

  test('maps Close Long (close all) to CLOSE LONG', () => {
    expect(formatActionLabel({ action: 'Close Long (close all)' })).toBe('CLOSE LONG');
  });

  test('maps Open Short', () => {
    expect(formatActionLabel({ action: 'Open Short' })).toBe('OPEN SHORT');
  });

  test('maps Increase Short to ADD SHORT', () => {
    expect(formatActionLabel({ action: 'Increase Short' })).toBe('ADD SHORT');
  });

  test('maps Decrease Short to CLOSE SHORT', () => {
    expect(formatActionLabel({ action: 'Decrease Short' })).toBe('CLOSE SHORT');
  });

  test('falls back to side when action unknown', () => {
    expect(formatActionLabel({ side: 'buy' })).toBe('OPEN LONG');
    expect(formatActionLabel({ side: 'sell' })).toBe('OPEN SHORT');
  });

  test('returns uppercase action for unknown action', () => {
    expect(formatActionLabel({ action: 'custom action' })).toBe('CUSTOM ACTION');
  });

  test('returns TRADE when no action or side', () => {
    expect(formatActionLabel({})).toBe('TRADE');
  });

  test('handles case insensitivity', () => {
    expect(formatActionLabel({ action: 'OPEN LONG' })).toBe('OPEN LONG');
    expect(formatActionLabel({ action: 'open long' })).toBe('OPEN LONG');
    expect(formatActionLabel({ action: 'Open long' })).toBe('OPEN LONG');
  });
});

describe('Holding Display', () => {
  function sideFromSize(size: number): 'long' | 'short' | 'flat' {
    if (size > 0) return 'long';
    if (size < 0) return 'short';
    return 'flat';
  }

  function formatHoldingSize(size: number, symbol: string): string {
    const direction = sideFromSize(size);
    if (direction === 'flat') return 'No position';
    const magnitude = Math.abs(size);
    const precision = magnitude >= 1 ? 2 : 3;
    const sign = size >= 0 ? '+' : '-';
    return `${sign}${magnitude.toFixed(precision)} ${symbol}`;
  }

  test('formats long position', () => {
    expect(formatHoldingSize(0.5, 'BTC')).toBe('+0.500 BTC');
    expect(formatHoldingSize(1.5, 'BTC')).toBe('+1.50 BTC');
  });

  test('formats short position', () => {
    expect(formatHoldingSize(-0.5, 'BTC')).toBe('-0.500 BTC');
    expect(formatHoldingSize(-1.5, 'BTC')).toBe('-1.50 BTC');
  });

  test('formats flat position', () => {
    expect(formatHoldingSize(0, 'BTC')).toBe('No position');
  });

  test('formats ETH positions', () => {
    expect(formatHoldingSize(5.0, 'ETH')).toBe('+5.00 ETH');
    expect(formatHoldingSize(-2.5, 'ETH')).toBe('-2.50 ETH');
  });

  test('uses appropriate precision', () => {
    expect(formatHoldingSize(0.123, 'BTC')).toBe('+0.123 BTC'); // 3 decimals for < 1
    expect(formatHoldingSize(1.234, 'BTC')).toBe('+1.23 BTC'); // 2 decimals for >= 1
    expect(formatHoldingSize(100.567, 'BTC')).toBe('+100.57 BTC');
  });
});

describe('HTML Escaping', () => {
  function escapeHtml(text: string | null | undefined): string {
    if (!text) return '';
    const div = { textContent: '', innerHTML: '' };
    div.textContent = text;
    // Simulate browser behavior
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  test('escapes HTML tags', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  test('escapes quotes', () => {
    expect(escapeHtml('He said "hello"')).toBe('He said &quot;hello&quot;');
    expect(escapeHtml("It's fine")).toBe("It&#039;s fine");
  });

  test('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  test('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('preserves safe text', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });
});

describe('Ethereum Address Validation (Client-side)', () => {
  function isValidEthAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  test('accepts valid lowercase address', () => {
    expect(isValidEthAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
  });

  test('accepts valid uppercase address', () => {
    expect(isValidEthAddress('0x1234567890ABCDEF1234567890ABCDEF12345678')).toBe(true);
  });

  test('accepts valid mixed-case address', () => {
    expect(isValidEthAddress('0x1234567890AbCdEf1234567890AbCdEf12345678')).toBe(true);
  });

  test('rejects address without 0x prefix', () => {
    expect(isValidEthAddress('1234567890abcdef1234567890abcdef12345678')).toBe(false);
  });

  test('rejects address with wrong length', () => {
    expect(isValidEthAddress('0x1234')).toBe(false);
    expect(isValidEthAddress('0x1234567890abcdef1234567890abcdef123456789')).toBe(false);
  });

  test('rejects address with invalid characters', () => {
    expect(isValidEthAddress('0x1234567890ghijkl1234567890ghijkl12345678')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidEthAddress('')).toBe(false);
  });
});
