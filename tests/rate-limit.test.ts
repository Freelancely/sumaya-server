/**
 * The rate limiter, against the real table.
 *
 * The rest of the suite runs with limits off — every request in it comes from
 * 127.0.0.1, so real windows would trip on assertions about something else
 * entirely. This file turns the switch back on for itself, which is the only
 * place that mutation is appropriate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env } from "../src/config/env.js";
import { prisma } from "../src/db/prisma.js";
import { RateLimitError } from "../src/http/errors.js";
import { enforceRateLimit, pruneRateLimits, RateLimits } from "../src/http/rateLimit.js";
import { app, createAdmin, request, resetDatabase } from "./helpers.js";

const rule = { name: "test:rule", limit: 3, windowSeconds: 60 };

beforeAll(() => {
  (env as { RATE_LIMITS_ENABLED: boolean }).RATE_LIMITS_ENABLED = true;
});

afterAll(() => {
  (env as { RATE_LIMITS_ENABLED: boolean }).RATE_LIMITS_ENABLED = false;
});

beforeEach(async () => {
  await resetDatabase();
});

describe("enforceRateLimit", () => {
  it("allows requests up to the limit and refuses the one after", async () => {
    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await expect(enforceRateLimit(rule, "1.2.3.4")).resolves.toBeUndefined();
    }

    await expect(enforceRateLimit(rule, "1.2.3.4")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("counts each identifier in its own window", async () => {
    for (let attempt = 0; attempt < rule.limit + 1; attempt += 1) {
      await enforceRateLimit(rule, "1.2.3.4").catch(() => undefined);
    }

    // A different caller is unaffected by the first one's exhaustion.
    await expect(enforceRateLimit(rule, "5.6.7.8")).resolves.toBeUndefined();
  });

  it("reports how long the caller must wait", async () => {
    for (let attempt = 0; attempt < rule.limit; attempt += 1) await enforceRateLimit(rule, "1.2.3.4");

    const error = await enforceRateLimit(rule, "1.2.3.4").then(
      () => undefined,
      (thrown: unknown) => thrown as RateLimitError,
    );

    expect(error).toBeInstanceOf(RateLimitError);
    if (!error) throw new Error("unreachable");

    expect(error.status).toBe(429);
    expect(error.code).toBe("RATE_LIMITED");
    expect(Number(error.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect(Number(error.headers?.["Retry-After"])).toBeLessThanOrEqual(rule.windowSeconds);
  });

  it("starts a fresh window once the previous one has lapsed", async () => {
    for (let attempt = 0; attempt < rule.limit; attempt += 1) await enforceRateLimit(rule, "1.2.3.4");
    await expect(enforceRateLimit(rule, "1.2.3.4")).rejects.toBeInstanceOf(RateLimitError);

    // Expire the window in place rather than waiting 60 seconds for it.
    await prisma.rateLimit.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(enforceRateLimit(rule, "1.2.3.4")).resolves.toBeUndefined();
  });

  it("stores no readable identifier — only a hash", async () => {
    await enforceRateLimit(rule, "user@example.com");

    const rows = await prisma.rateLimit.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toContain("test:rule:");
    expect(rows[0].key).not.toContain("user@example.com");
  });

  it("prunes only the windows that have lapsed", async () => {
    await enforceRateLimit(rule, "live");
    await enforceRateLimit(rule, "stale");
    await prisma.rateLimit.updateMany({
      where: { key: { contains: "test:rule" } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await enforceRateLimit({ ...rule, name: "test:other" }, "live");

    const pruned = await pruneRateLimits();

    expect(pruned).toBe(2);
    expect(await prisma.rateLimit.count()).toBe(1);
  });
});

describe("the limits the endpoints declare", () => {
  it("throttles login, and says when to come back", async () => {
    await createAdmin();

    // The login route counts per IP and per IP+address, both at the same rule.
    const attempts = RateLimits.login.limit + 1;
    let lastStatus = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await request(app)
        .post("/api/auth/login")
        .send({ email: `nobody${attempt}@example.com`, password: "Wrong-Password-1" });
      lastStatus = response.status;

      if (response.status === 429) {
        expect(response.body.error.code).toBe("RATE_LIMITED");
        expect(response.headers["retry-after"]).toBeTruthy();
        break;
      }
    }

    expect(lastStatus).toBe(429);
  });

  it("throttles the public enquiry form, per address", async () => {
    const enquiry = {
      name: "Dana Al-Sabah",
      email: "dana@example.com",
      message: "I would like to talk about reworking an heirloom ring.",
    };

    // The per-address window is the tighter of the two the route declares.
    for (let attempt = 0; attempt < RateLimits.contactByEmail.limit; attempt += 1) {
      await request(app).post("/api/contact").send(enquiry).expect(202);
    }

    const limited = await request(app).post("/api/contact").send(enquiry).expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("leaves the public catalogue well clear of its limit for ordinary use", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).get("/api/categories").expect(200);
    }
  });
});
