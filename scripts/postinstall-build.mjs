/**
 * Compiles the server as part of `npm install`.
 *
 * Render's default build command is `npm install`, which never runs
 * `npm run build`. `dist/` is gitignored, so the service started against a
 * directory that did not exist: `Cannot find module '.../dist/server.js'`.
 * Hanging the build off postinstall means the deploy is correct whatever the
 * dashboard's build command happens to say.
 *
 * The guard matters. In the Dockerfile `npm ci` runs BEFORE `src` is copied in,
 * so compiling unconditionally would fail the install step; there, this exits
 * quietly and the explicit `npm run build` that follows does the work. The same
 * guard covers anyone installing this package without its sources.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!existsSync(join(root, "src", "server.ts"))) {
  console.log("postinstall: no src/server.ts — skipping build");
  process.exit(0);
}

// `tsc` is a devDependency. An install that omitted dev dependencies cannot
// build, and saying so beats a bare "command not found".
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error(
    "postinstall: typescript is not installed — the build needs devDependencies.\n" +
      "Set NPM_CONFIG_PRODUCTION=false (or drop --omit=dev) and install again."
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
