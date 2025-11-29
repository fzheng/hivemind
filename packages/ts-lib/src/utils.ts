/**
 * Utility Functions Module
 *
 * Provides common utility functions used throughout the application,
 * including HTTP fetch with retry, time utilities, and string helpers.
 *
 * @module utils
 */

/**
 * Performs an HTTP fetch with exponential backoff retry logic.
 * Retries on network errors and non-2xx status codes.
 *
 * @param url - URL to fetch
 * @param init - Fetch request init options
 * @param opts - Retry configuration
 * @param opts.retries - Maximum retry attempts (default: 2)
 * @param opts.baseDelayMs - Base delay in milliseconds for exponential backoff (default: 500)
 * @returns Promise resolving to parsed JSON response
 * @throws Error after all retry attempts are exhausted
 *
 * @example
 * ```typescript
 * const data = await fetchWithRetry<{ price: string }>(
 *   'https://api.example.com/price',
 *   { method: 'GET' },
 *   { retries: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function fetchWithRetry<T = unknown>(
  url: string,
  init: RequestInit,
  opts?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? 2;
  const base = opts?.baseDelayMs ?? 500;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = base * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}

/**
 * Clamps a number to a specified range.
 *
 * @param x - Value to clamp
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Value clamped to [min, max]
 *
 * @example
 * ```typescript
 * clamp(5, 0, 10)   // 5
 * clamp(-5, 0, 10)  // 0
 * clamp(15, 0, 10)  // 10
 * ```
 */
export function clamp(x: number, min: number, max: number) {
  return Math.max(min, Math.min(max, x));
}

/**
 * Returns the current time as an ISO 8601 string.
 *
 * @returns Current timestamp in ISO format (e.g., '2025-01-15T10:30:00.000Z')
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Pauses execution for a specified duration.
 * Useful for rate limiting or delays between operations.
 *
 * @param ms - Duration to sleep in milliseconds
 * @returns Promise that resolves after the delay
 *
 * @example
 * ```typescript
 * await sleep(1000); // Wait 1 second
 * ```
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes an Ethereum address by trimming whitespace and converting to lowercase.
 * Does not validate the address format.
 *
 * @param value - Address string to normalize
 * @returns Trimmed, lowercase address
 *
 * @example
 * ```typescript
 * normalizeAddress('  0xABC123...  ') // '0xabc123...'
 * ```
 */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
