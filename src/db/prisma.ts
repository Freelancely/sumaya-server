/**
 * Prisma client singleton.
 *
 * A long-running server can hold a real connection pool, which is the main
 * thing that changes here relative to a serverless deployment: `pg` keeps a
 * handful of TCP connections open for the life of the process instead of
 * opening one per invocation, so `DATABASE_POOL_MAX` — not the request rate —
 * bounds what the database sees.
 *
 * Caching on `globalThis` still matters in development, where the watcher
 * reloads modules and would otherwise leak a pool per reload.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../config/env.js";
import { PrismaClient } from "./generated/client.js";

declare global {
  // eslint-disable-next-line no-var
  var __sumayaPrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      // A connection that cannot be established should fail the request, not
      // hang it until the client gives up.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    }),
    log: env.isProduction ? ["error"] : ["error", "warn"],
  });
}

export const prisma: PrismaClient = globalThis.__sumayaPrisma ?? create();

if (!env.isProduction) globalThis.__sumayaPrisma = prisma;

/** Called on shutdown so in-flight queries finish and sockets close cleanly. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
  globalThis.__sumayaPrisma = undefined;
}

export { PrismaClient };

/** The client type handed to an interactive `prisma.$transaction` callback. */
export type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
