/**
 * The handful of values the global setup and the workers both need.
 *
 * They live in their own module because `global-setup.ts` runs in Vitest's main
 * process while `env.ts` runs in each worker: the two never share memory, only
 * this file.
 */

/** Overridable so a machine already using this port can move the suite. */
export const TEST_PG_PORT = Number(process.env.TEST_PG_PORT ?? 54329);
export const TEST_PG_HOST = "127.0.0.1";

/**
 * PGlite ignores the credentials and database name — it serves exactly one
 * database — but `pg` insists on a well-formed URL.
 */
export const TEST_DATABASE_URL = `postgresql://postgres:postgres@${TEST_PG_HOST}:${TEST_PG_PORT}/postgres`;
