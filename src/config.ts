function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
     throw new Error(`${name} is required — refusing to start with a default signing secret`);
  }
  return value;
}


/* pg_try_advisory_lock() takes a bigint, so a readable env value is folded into
 * a stable 32-bit key instead of being passed through as text. A numeric value
 * is used as-is. */
function lockKeyOf(raw: string | undefined, fallback: string): number {
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (/^-?\d+$/.test(value)) return Number(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function list(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
}

/* Accepts "https" or "https:" and normalizes to what URL.protocol returns. */
function schemes(raw: string | undefined, fallback: string[]): string[] {
  return list(raw, fallback).map((scheme) => (scheme.endsWith(':') ? scheme : `${scheme}:`));
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    connectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000,
    reconnectMaxDelayMs: Number(process.env.REDIS_RECONNECT_MAX_DELAY_MS) || 3000
  },

  postgres: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stocktracker",
    poolMax: num(process.env.PG_POOL_MAX, 10),
    connectionTimeoutMs: num(process.env.PG_CONNECTION_TIMEOUT_MS, 5000),
    idleTimeoutMs: num(process.env.PG_IDLE_TIMEOUT_MS, 30000),
    startupRetries: num(process.env.PG_STARTUP_RETRIES, 10),
    startupRetryDelayMs: num(process.env.PG_STARTUP_RETRY_DELAY_MS, 1000),
  },
  brapi: {
    baseUrl: process.env.BRAPI_BASE_URL ?? "https://brapi.dev/api",
    token: process.env.BRAPI_TOKEN ?? null,
    timeoutMs: Number(process.env.BRAPI_TIMEOUT_MS) || 5000,
    retryCount: Number(process.env.BRAPI_RETRY_COUNT) || 3,
    retryBaseDelayMs: Number(process.env.BRAPI_RETRY_BASE_DELAY_MS) || 1000
  },
  alerts : {
    pollerEnabled: bool(process.env.ALERTS_POLLER_ENABLED, true),
    pollerIntervalMs: Number(process.env.ALERTS_POLLER_INTERVAL_MS) || 60000, // 1 minute
    batchSize: Number(process.env.ALERTS_BATCH_SIZE) || 100,
    lockKey: lockKeyOf(process.env.ALERTS_LOCK_KEY, "alerts_poller_lock"),
    pollIntervalMs: Number(process.env.ALERTS_POLL_INTERVAL_MS) || 60000, // 1 minute
  },
  db: {
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stocktracker",
    maxPoolSize: Number(process.env.DB_MAX_POOL_SIZE) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000,
  },
   quotes: {
    cacheTtlSeconds: num(process.env.QUOTE_CACHE_TTL, 60),
    cachePrefix: process.env.QUOTE_CACHE_PREFIX ?? 'quote:',
    maxSymbolsPerRequest: num(process.env.QUOTE_MAX_SYMBOLS, 10),
  },
  /* Behind a reverse proxy every request arrives from the proxy's address, so
   * the per-IP rate limits would be shared by everyone. Only enable it when a
   * proxy you control sets X-Forwarded-For; otherwise a client forges it. */
  trustProxy: bool(process.env.TRUST_PROXY, false),
  auth: {
    jwtSecret: required('JWT_SECRET'),
    tokenTtlSeconds: num(process.env.JWT_TTL_SECONDS, 3600),
  },
  passwordReset: {
    tokenTtlSeconds: num(process.env.PASSWORD_RESET_TTL_SECONDS, 1800),
    /* Front-end page that reads the token from the URL fragment. Without it the
     * e-mail carries the bare token. */
    url: process.env.PASSWORD_RESET_URL || null,
    windowSeconds: num(process.env.PASSWORD_RESET_WINDOW_SECONDS, 3600),
    maxPerIp: num(process.env.PASSWORD_RESET_MAX_PER_IP, 10),
    maxPerEmail: num(process.env.PASSWORD_RESET_MAX_PER_EMAIL, 3),
  },
  notifications: {
    webhookTimeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 5000),
    /* A user-supplied webhook destination is checked against these before every
     * delivery; see src/lib/webhookUrl.ts. */
    webhookSchemes: schemes(process.env.WEBHOOK_ALLOWED_SCHEMES, ['https']),
    webhookAllowedHosts: list(process.env.WEBHOOK_ALLOWED_HOSTS, []),
    webhookAllowPrivate: bool(process.env.WEBHOOK_ALLOW_PRIVATE, false),
  },
  quoteCacheTTL: Number(process.env.QUOTE_CACHE_TTL) ||  60,
  digest: {
    enabled: bool(process.env.DIGEST_ENABLED, true),
    checkIntervalMS:  num(process.env.DIGEST_CHECK_INTERVAL_MS, 15 * 60 * 1000),
    sendHour: num(process.env.DIGEST_SEND_HOUR, 18),
    timeZone: process.env.DIGEST_TIME_ZONE ?? 'America/Sao_Paulo',
    lockKey: lockKeyOf(process.env.DIGEST_LOCK_KEY, 'digest_worker_lock'),
  },
  mail: {
    smtpUrl: process.env.SMTP_URL || null,
    from: process.env.EMAIL_FROM ?? 'stocktracker@localhost',
  }
};
