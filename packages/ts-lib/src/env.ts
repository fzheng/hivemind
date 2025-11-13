export function getEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return value;
}

export function requireEnv(name: string, fallback?: string): string {
  const value = getEnv(name, fallback);
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export function getPort(defaultPort = 8080): number {
  const raw = Number(getEnv('PORT'));
  if (Number.isFinite(raw) && raw > 0) return raw;
  return defaultPort;
}

export function getOwnerToken(): string {
  return requireEnv('OWNER_TOKEN', 'dev-owner');
}
