import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `globalSetup` boots one in-process Postgres for the whole run;
    // `setupFiles` points each worker's environment at it before any
    // application module — and therefore `config/env.ts` — is imported.
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/env.ts"],
    include: ["tests/**/*.test.ts"],
    // One database, one socket, and therefore one worker.
    //
    // PGlite serves a single client connection at a time, so a second worker
    // process opening its own pool gets the first one's connection closed
    // underneath it. Running every file in one forked process means one Prisma
    // client, one connection, and files that take turns — which is also what
    // makes each file's `resetDatabase()` a reliable starting point.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // bcrypt at cost 12 is deliberately slow, and several tests sign in more
    // than once.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
