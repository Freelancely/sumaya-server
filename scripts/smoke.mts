/**
 * Boots the built server against a throwaway Postgres and drives it over real
 * HTTP: sign in, create a piece, read it back anonymously, shut down.
 *
 * The test suite exercises the app object; this exercises the *process* — the
 * entry point, the listener, the pool, and the signal handling that a container
 * platform depends on. Run it with `npm run smoke` after a build.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PG_PORT = 54330;
const API_PORT = 41234;
const BASE = `http://127.0.0.1:${API_PORT}`;
const ADMIN = { email: "smoke@example.com", password: "Correct-Horse-9" };

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

/** Polls until the server answers, so this does not race the process starting. */
async function waitForReady(attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the server never became healthy");
}

const db = await PGlite.create();
const migrations = join(process.cwd(), "prisma", "migrations");
for (const entry of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).sort()) {
  await db.exec(readFileSync(join(migrations, entry.name, "migration.sql"), "utf8"));
}
await db.exec(`
  INSERT INTO categories (id, label, singular, position, is_active)
  VALUES ('rings', 'Rings', 'Ring', 0, true)
`);

const pg = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1" });
await pg.start();

const environment = {
  ...process.env,
  NODE_ENV: "development",
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
  DATABASE_POOL_MAX: "1",
  JWT_SECRET: "smoke-jwt-secret-that-is-long-enough-0000",
  JWT_REFRESH_SECRET: "smoke-refresh-secret-that-is-long-enough1",
  STORAGE_DRIVER: "memory",
  MAIL_DRIVER: "memory",
  RATE_LIMITS_ENABLED: "false",
  SUPERADMIN_EMAIL: ADMIN.email,
  SUPERADMIN_PASSWORD: ADMIN.password,
  LOG_LEVEL: "warn",
};

// Seed through the real seed script, which is how a deployment does it.
await new Promise<void>((resolve, reject) => {
  const seed = spawn("npx", ["tsx", "prisma/seed.ts"], { env: environment, shell: true, stdio: "inherit" });
  seed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
});

const server = spawn("node", ["dist/server.js"], { env: environment, stdio: "inherit" });

try {
  await waitForReady();

  const ready = await fetch(`${BASE}/ready`);
  check(ready.status === 200, "GET /ready reports the database is reachable");

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const session = await login.json();
  check(login.status === 200 && session.accessToken, "POST /api/auth/login returns an access token");
  check(
    (login.headers.getSetCookie?.() ?? []).some((cookie) => cookie.includes("HttpOnly")),
    "the refresh token comes back as an httpOnly cookie",
  );

  const auth = { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" };

  const create = await fetch(`${BASE}/api/pieces`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name: "Smoke Test Ring",
      category: "rings",
      metal: "18k yellow gold",
      story: "Proving the process boots.",
      stones: ["Ruby"],
    }),
  });
  check(create.status === 201, "POST /api/pieces creates a piece");

  const publicRead = await fetch(`${BASE}/api/pieces`);
  const listing = await publicRead.json();
  check(listing.pieces?.[0]?.id === "smoke-test-ring", "GET /api/pieces serves it to an anonymous caller");

  const categories = await (await fetch(`${BASE}/api/categories`)).json();
  check(categories.categories[0].count === 1, "GET /api/categories counts it");

  const unauthorised = await fetch(`${BASE}/api/pieces`, { method: "POST", body: "{}" });
  check(unauthorised.status === 401, "an anonymous write is refused");

  console.log("\nSmoke test passed.");
} finally {
  // SIGTERM is what a container runtime sends; the process should close the
  // listener, drain, and exit 0.
  server.kill("SIGTERM");
  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null }), 8000);
    server.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  if (exited.code === null && exited.signal === null) {
    server.kill("SIGKILL");
    throw new Error("the server did not exit on SIGTERM");
  }

  // Windows has no real SIGTERM: `kill` terminates the child outright, so the
  // graceful path can only be asserted where signals actually exist.
  if (process.platform === "win32") {
    check(true, "the server terminates on shutdown (signals are not delivered on Windows)");
  } else {
    check(exited.code === 0, "the server exits cleanly on SIGTERM");
  }

  await pg.stop();
  await db.close();
}
