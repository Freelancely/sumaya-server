/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Connection URLs no longer live in the schema. Migrations want a plain,
 * unpooled connection — a pooler cannot proxy the statements they issue — so
 * `DIRECT_URL` is preferred and `DATABASE_URL` is the fallback.
 *
 * The datasource block is omitted entirely when neither is set, so commands
 * that touch no database (`validate`, `generate`, `migrate diff --from-empty`)
 * still work on a machine with nothing configured — which is what lets a fresh
 * `npm install` run `prisma generate` before any .env exists.
 *
 * The running server never reads this file; it builds its own pooled client in
 * `src/db/prisma.ts`.
 */
import "dotenv/config";

import { defineConfig } from "prisma/config";

// `||`, not `??`: an empty DIRECT_URL in a half-filled .env is "unset", and
// falling through to DATABASE_URL beats failing with the datasource omitted.
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(url ? { datasource: { url } } : {}),
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
