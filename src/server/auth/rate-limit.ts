import { prisma } from '../db';
import { apiError } from '../errors';

export interface RateLimitRule {
  /** Stable identifier, e.g. `login:ip:203.0.113.4`. */
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter kept in Postgres rather than in process memory.
 * In-memory limiting is worthless on serverless and merely misleading behind
 * more than one instance: each replica would enforce its own private quota.
 *
 * Fixed windows can allow up to 2x the limit across a window boundary. For
 * login throttling that is an acceptable trade against the cost of a sliding
 * log, and per-account lockout is the real backstop.
 */
export async function consumeRateLimit(rule: RateLimitRule): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs);

  // One statement, so concurrent requests cannot interleave a read and a write.
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${rule.key}, ${windowStart}, 1)
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limits.window_start < ${windowStart} THEN 1
            ELSE rate_limits.count + 1
          END,
          window_start = GREATEST(rate_limits.window_start, ${windowStart})
    RETURNING count
  `;

  const count = rows[0]?.count ?? 1;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + rule.windowMs - now.getTime()) / 1000),
  );

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  };
}

/**
 * Reads the current count without incrementing it.
 *
 * Needed because some limits should only count *failures*: a school shares one
 * public IP, so thirty students signing in at the start of a lesson is normal
 * traffic, while thirty failed passwords from one address is not. Counting
 * every attempt would throttle the classroom and let a slow attacker through
 * on the same budget.
 */
export async function peekRateLimit(rule: RateLimitRule): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs);

  const row = await prisma.rateLimit.findUnique({ where: { key: rule.key } });
  const count = row && row.windowStart >= windowStart ? row.count : 0;

  return {
    allowed: count < rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart.getTime() + rule.windowMs - now.getTime()) / 1000),
    ),
  };
}

export async function enforceRateLimitPeek(rule: RateLimitRule): Promise<void> {
  const result = await peekRateLimit(rule);
  if (!result.allowed) {
    throw apiError('rate_limited', 'Too many failed attempts. Please wait and try again.', {
      retry_after_seconds: result.retryAfterSeconds,
    });
  }
}

export async function enforceRateLimit(rule: RateLimitRule): Promise<void> {
  const result = await consumeRateLimit(rule);
  if (!result.allowed) {
    throw apiError('rate_limited', 'Too many attempts. Please wait and try again.', {
      retry_after_seconds: result.retryAfterSeconds,
    });
  }
}

/** Old windows are dead weight; the cron route sweeps them. */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const { count } = await prisma.rateLimit.deleteMany({
    where: { windowStart: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return count;
}
