import { redisClient } from '../redis/redis.ts';

/* Fixed window: the first hit creates the counter with its expiry, later hits
 * only increment. One script so INCR and EXPIRE cannot be split by a crash,
 * which would leave a counter that never resets. */
const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('TTL', KEYS[1])}
`;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets, for the Retry-After header. */
  retryAfterSeconds: number;
}

/* Counts this hit against `key`. Throws when Redis does; the caller decides
 * whether that fails open or closed. */
export async function hitRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const [count, ttl] = (await redisClient.eval(HIT, {
    keys: [key],
    arguments: [String(windowSeconds)],
  })) as [number, number];
  return { allowed: count <= limit, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
}
