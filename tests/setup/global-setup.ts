/**
 * Boots a real Postgres for the test run — in this process.
 *
 * PGlite is Postgres itself compiled to WebAssembly, fronted here by a socket
 * server so the application connects with the same `pg` driver, the same
 * Prisma adapter and the same SQL it uses in production. That matters more than
 * the convenience: a fake repository layer would happily accept queries a real
 * database rejects, and the invariants worth testing here — the featured-piece
 * transaction, the rate-limit upsert, the cascade on delete — are exactly the
 * ones only a real engine gets right.
 *
 * The schema is applied from `prisma/migrations`, so the suite runs against the
 * DDL that will actually be deployed rather than a re-derived approximation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { TEST_PG_HOST, TEST_PG_PORT } from "./constants.js";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Prisma's directory names are timestamp-prefixed, so lexical order is
    // chronological order.
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => join(MIGRATIONS_DIR, entry.name, "migration.sql"));
}

export async function setup(): Promise<() => Promise<void>> {
  const db = await PGlite.create();

  for (const file of migrationFiles()) {
    await db.exec(readFileSync(file, "utf8"));
  }

  const server = new PGLiteSocketServer({ db, port: TEST_PG_PORT, host: TEST_PG_HOST });
  await server.start();

  return async () => {
    await server.stop();
    await db.close();
  };
}
