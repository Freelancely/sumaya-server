/**
 * Environment contract.
 *
 * Parsed once at module load so a missing or malformed variable stops the
 * server at boot with a readable message, rather than surfacing as a confusing
 * 500 on whichever request happens to touch that feature first. A long-running
 * process gets this for free: unlike a serverless function, it either starts or
 * it does not, and an operator sees the failure immediately.
 */
import { z } from "zod";

/** `"1"`, `"true"`, `"yes"` → true. Anything else falsey. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? fallback : /^(1|true|yes|on)$/i.test(value)));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /** Where the HTTP server listens. */
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    HOST: z.string().default("0.0.0.0"),
    /**
     * Set when the process sits behind a reverse proxy (nginx, a load
     * balancer). Off by default: trusting `x-forwarded-for` from a direct
     * client would let anyone spoof the IP every rate limit is counted against.
     */
    TRUST_PROXY: boolish(false),

    /** Postgres connection for the pool this process holds open. */
    DATABASE_URL: z.string().url(),
    /** Unpooled connection. Used by `prisma migrate` only. */
    DIRECT_URL: z.string().url().optional(),
    /** Upper bound on pooled connections; keep it under the server's limit. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    /** Seconds. Short by design — the refresh cookie carries the long session. */
    ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

    /** `memory` keeps uploads in-process; it exists for tests and local work. */
    STORAGE_DRIVER: z.enum(["cloudinary", "memory"]).default("cloudinary"),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    CLOUDINARY_FOLDER: z.string().default("sumaya/pieces"),

    /** `console` prints the message; `memory` also keeps it for assertions. */
    MAIL_DRIVER: z.enum(["resend", "console", "memory"]).optional(),
    RESEND_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().default("Sumaya Atelier <no-reply@sumayahmurafie.com>"),

    /** Public origin of the SPA; reset links are built from it. */
    APP_URL: z.string().url().default("http://localhost:8080"),
    /** Comma-separated allowlist. Defaults to APP_URL when unset. */
    CORS_ORIGINS: z.string().optional(),

    /** Turning limits off is a test affordance; production refuses to. */
    RATE_LIMITS_ENABLED: boolish(true),

    /** Consumed by `prisma/seed.ts` only; absent at runtime is fine. */
    SUPERADMIN_EMAIL: z.string().email().optional(),
    SUPERADMIN_PASSWORD: z.string().optional(),
    SUPERADMIN_NAME: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const require = (key: string, present: unknown, why: string) => {
      if (!present) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: why });
    };

    if (value.STORAGE_DRIVER === "cloudinary") {
      require("CLOUDINARY_CLOUD_NAME", value.CLOUDINARY_CLOUD_NAME, "required when STORAGE_DRIVER=cloudinary");
      require("CLOUDINARY_API_KEY", value.CLOUDINARY_API_KEY, "required when STORAGE_DRIVER=cloudinary");
      require("CLOUDINARY_API_SECRET", value.CLOUDINARY_API_SECRET, "required when STORAGE_DRIVER=cloudinary");
    }

    if (value.MAIL_DRIVER === "resend") {
      require("RESEND_API_KEY", value.RESEND_API_KEY, "required when MAIL_DRIVER=resend");
    }

    if (value.NODE_ENV === "production") {
      // The in-memory substitutes silently throw away real work. Catching that
      // at boot is the whole reason this block exists.
      if (value.STORAGE_DRIVER !== "cloudinary") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STORAGE_DRIVER"], message: "must be cloudinary in production" });
      }
      if ((value.MAIL_DRIVER ?? (value.RESEND_API_KEY ? "resend" : "console")) !== "resend") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["MAIL_DRIVER"], message: "must be resend in production — set RESEND_API_KEY" });
      }
      if (!value.RATE_LIMITS_ENABLED) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["RATE_LIMITS_ENABLED"], message: "cannot be disabled in production" });
      }
    }
  });

type Parsed = z.infer<typeof schema>;

export type Env = Parsed & {
  corsOrigins: string[];
  isProduction: boolean;
  isTest: boolean;
  /** Resolved from MAIL_DRIVER, falling back to whether a key is configured. */
  mailDriver: "resend" | "console" | "memory";
};

function load(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;
  const corsOrigins = (value.CORS_ORIGINS ?? value.APP_URL)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    ...value,
    corsOrigins,
    isProduction: value.NODE_ENV === "production",
    isTest: value.NODE_ENV === "test",
    mailDriver: value.MAIL_DRIVER ?? (value.RESEND_API_KEY ? "resend" : "console"),
  };
}

export const env: Env = load();

/** Exposed for the configuration tests, which check the rules above directly. */
export { load as loadEnv, schema as envSchema };
