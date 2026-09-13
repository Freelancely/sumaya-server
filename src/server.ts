/**
 * Process entry point: listen, and stop cleanly.
 *
 * Graceful shutdown is the part a serverless deployment never had to write and
 * the part a container platform depends on. On SIGTERM the listener stops
 * accepting new connections, in-flight requests are given a window to finish,
 * and only then does the database pool close — so a rolling deploy does not
 * turn a handful of live requests into 502s.
 */
import "dotenv/config";

import type { Server } from "node:http";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { disconnect, prisma } from "./db/prisma.js";
import { describeError, logger } from "./logging/logger.js";

/** How long in-flight requests get before the process stops waiting for them. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Fail before the port is bound if the database is unreachable: a process
  // that accepts traffic it cannot serve is worse than one that never started.
  await prisma.$queryRaw`SELECT 1`;

  const server: Server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info("server listening", {
      port: env.PORT,
      host: env.HOST,
      env: env.NODE_ENV,
      storage: env.STORAGE_DRIVER,
      mail: env.mailDriver,
    });
  });

  // Without this a keep-alive connection idling between requests can be closed
  // mid-response by a proxy that gives up first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl-C means "stop waiting", not "run all of this twice".
    if (shuttingDown) {
      logger.warn("second signal received — exiting now", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });

    const timer = setTimeout(() => {
      logger.error("in-flight requests did not finish in time — forcing exit");
      // Sockets still mid-request; nothing left but to cut them.
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    // Do not let this timer be the reason the process stays alive.
    timer.unref();

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // `close` stops accepting new connections but waits on existing ones, and a
    // keep-alive socket sitting idle between requests would hold it open for
    // its full timeout. Idle ones have nothing in flight to lose, so they go
    // immediately; anything mid-request still gets the grace window above.
    server.closeIdleConnections();
    await closed;
    await disconnect();

    clearTimeout(timer);
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection has already escaped every `catch` we wrote, so the
  // process state is unknown from here. Log it and let the supervisor restart.
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", describeError(reason));
    void shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", describeError(error));
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  logger.error("server failed to start", describeError(error));
  process.exit(1);
});
