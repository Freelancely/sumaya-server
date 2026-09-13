/**
 * Structured JSON logging.
 *
 * One line per event, on stdout, with a `requestId` on every line — enough to
 * reconstruct a request from a user-reported id, which is all a 500 response
 * ever hands back. JSON rather than pretty text because whatever collects these
 * (journald, Docker, a log shipper) parses fields, and a human can still pipe
 * the stream through `jq`.
 */
type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Read straight from `process.env` rather than through `config/env.ts`: the
 * environment loader throws a readable error, and logging has to work while
 * that error is being reported. `silent` is what a test run uses.
 */
const threshold = (() => {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured === "silent") return Number.POSITIVE_INFINITY;
  return ORDER[(configured as Level) in ORDER ? (configured as Level) : "debug"];
})();

/** Keys whose values must never reach a log line, at any nesting depth. */
const REDACTED = new Set([
  "password",
  "currentpassword",
  "newpassword",
  "confirmpassword",
  "token",
  "refreshtoken",
  "accesstoken",
  "authorization",
  "cookie",
  "tokenhash",
  "passwordhash",
  "secret",
  "apikey",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Fields).map(([key, item]) => [
      key,
      REDACTED.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1),
    ]),
  );
}

function emit(level: Level, message: string, fields: Fields = {}): void {
  if (ORDER[level] < threshold) return;

  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(redact(fields) as Fields),
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** Derives a logger that stamps every line with additional context. */
  child(fields: Fields): Logger;
}

function build(base: Fields): Logger {
  return {
    debug: (message, fields) => emit("debug", message, { ...base, ...fields }),
    info: (message, fields) => emit("info", message, { ...base, ...fields }),
    warn: (message, fields) => emit("warn", message, { ...base, ...fields }),
    error: (message, fields) => emit("error", message, { ...base, ...fields }),
    child: (fields) => build({ ...base, ...fields }),
  };
}

export const logger = build({});

/** Normalises a thrown value into something safe to serialise. */
export function describeError(error: unknown): Fields {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "NonError", message: String(error) };
}
