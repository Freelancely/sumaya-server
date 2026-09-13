/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * A single process could hold these counters in memory, and that would be
 * faster — but it would also mean the limit quietly multiplies by the number of
 * replicas the moment this is run behind a load balancer, which is exactly when
 * it matters. One shared window in the database keeps the number honest at any
 * size. A fixed window (rather than a sliding log) keeps it to one atomic
 * upsert per request, the right trade for endpoints that mainly need to stop
 * credential stuffing, not to meter usage precisely.
 */
import { createHash } from "node:crypto";

import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { describeError, logger } from "../logging/logger.js";
import { RateLimitError } from "./errors.js";

export interface RateLimitRule {
  /** Stable prefix identifying the endpoint, e.g. "auth:login". */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Emails and IPs are hashed so the counter table holds no readable PII. */
function keyFor(rule: RateLimitRule, identifier: string): string {
  const digest = createHash("sha256").update(identifier).digest("hex").slice(0, 32);
  return `${rule.name}:${digest}`;
}

/**
 * Increments the window and throws once the limit is passed.
 *
 * A failure to reach the database must not take the endpoint down with it, so
 * this fails open and logs loudly — availability of login matters more than a
 * perfectly enforced counter, and authentication itself is unaffected.
 */
export async function enforceRateLimit(rule: RateLimitRule, identifier: string): Promise<void> {
  // Off only where a suite drives hundreds of requests from one address; the
  // environment schema refuses to start a production process this way.
  if (!env.RATE_LIMITS_ENABLED) return;

  const key = keyFor(rule, identifier);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + rule.windowSeconds * 1000);

  try {
    // One statement, so concurrent invocations can't interleave a read and a
    // write and both conclude they were under the limit. The CASE restarts the
    // window in place when the previous one has already lapsed.
    const rows = await prisma.$queryRaw<{ count: number; expires_at: Date }[]>`
      INSERT INTO rate_limits (key, count, expires_at)
      VALUES (${key}, 1, ${expiresAt})
      ON CONFLICT (key) DO UPDATE SET
        count      = CASE WHEN rate_limits.expires_at <= ${now} THEN 1 ELSE rate_limits.count + 1 END,
        expires_at = CASE WHEN rate_limits.expires_at <= ${now} THEN ${expiresAt} ELSE rate_limits.expires_at END
      RETURNING count, expires_at
    `;

    const row = rows[0];
    if (!row) return;

    if (row.count > rule.limit) {
      const retryAfter = (new Date(row.expires_at).getTime() - now.getTime()) / 1000;
      throw new RateLimitError(retryAfter);
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    logger.error("Rate limit check failed; allowing the request", {
      rule: rule.name,
      ...describeError(error),
    });
  }
}

/**
 * Drops lapsed rows. Nothing depends on this for correctness — an expired row
 * is already treated as a fresh window — so it is only housekeeping, called
 * opportunistically rather than on a schedule.
 */
export async function pruneRateLimits(): Promise<number> {
  const { count } = await prisma.rateLimit.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}

export const RateLimits = {
  login: { name: "auth:login", limit: 10, windowSeconds: 15 * 60 },
  forgotPasswordByEmail: { name: "auth:forgot:email", limit: 3, windowSeconds: 60 * 60 },
  forgotPasswordByIp: { name: "auth:forgot:ip", limit: 10, windowSeconds: 60 * 60 },
  resetPassword: { name: "auth:reset", limit: 10, windowSeconds: 60 * 60 },
  refresh: { name: "auth:refresh", limit: 60, windowSeconds: 15 * 60 },
  mutation: { name: "admin:mutation", limit: 60, windowSeconds: 60 },
  upload: { name: "admin:upload", limit: 30, windowSeconds: 60 },
  publicRead: { name: "public:read", limit: 300, windowSeconds: 60 },
  // The public forms. Deliberately tight: a legitimate visitor sends one
  // enquiry, and every message that gets through lands in a person's inbox.
  contactByIp: { name: "public:contact:ip", limit: 5, windowSeconds: 60 * 60 },
  contactByEmail: { name: "public:contact:email", limit: 3, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;
