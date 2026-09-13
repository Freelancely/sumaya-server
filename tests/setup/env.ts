/**
 * The environment each test worker runs under.
 *
 * This file is imported before any test file, and therefore before
 * `src/config/env.ts` reads `process.env` — which it does once, at module load.
 * Setting anything here after that point would be ignored.
 */
import { TEST_DATABASE_URL } from "./constants.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
// PGlite serves one connection at a time; a larger pool would only queue.
process.env.DATABASE_POOL_MAX = "1";

// Fixed rather than random, so a failing assertion about a token is the same
// failure on the next run.
process.env.JWT_SECRET = "test-jwt-secret-that-is-long-enough-000000";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret-long-enough-00000";
process.env.ACCESS_TOKEN_TTL = "900";
process.env.REFRESH_TOKEN_TTL = "2592000";

// The substitutes: uploads stay in memory and mail lands in an outbox the
// tests read, so nothing here needs a Cloudinary or Resend account.
process.env.STORAGE_DRIVER = "memory";
process.env.MAIL_DRIVER = "memory";
// Where the contact endpoints deliver. Named here so a test asserts against a
// fixed address rather than whichever inbox the deployment happens to use.
process.env.CONTACT_TO = "atelier-inbox@example.com";

process.env.APP_URL = "http://localhost:8080";
process.env.CORS_ORIGINS = "http://localhost:8080,http://localhost:3000";

// Every request in the suite comes from 127.0.0.1, so real limits would trip on
// the sixth login rather than on anything the test meant to assert. The limiter
// itself is covered directly in `rate-limit.test.ts`, which turns it back on.
process.env.RATE_LIMITS_ENABLED = "false";

// Quiet by default: a passing test should print its assertions, not a log stream.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
