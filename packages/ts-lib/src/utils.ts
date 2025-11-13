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

export function clamp(x: number, min: number, max: number) {
  return Math.max(min, Math.min(max, x));
}

export function nowIso() {
  return new Date().toISOString();
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
