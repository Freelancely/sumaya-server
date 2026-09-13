/**
 * The single source of truth for request shapes.
 *
 * These schemas are deliberately free of any server-only import so the admin
 * UI can import them directly and validate a form with exactly the rules the
 * API enforces — one definition, no drift between client and server messages.
 */
import { z } from "zod";

/* ── Primitives ───────────────────────────────────────────────── */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email("Enter a valid email address.");

/**
 * Length is the honest lever here; composition rules mostly push people toward
 * predictable substitutions. 12 characters minimum, 200 max so a long
 * passphrase is welcome but bcrypt's 72-byte input limit stays visible.
 */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(200, "Password must be at most 200 characters.")
  .refine((value) => /[a-z]/.test(value), "Password must contain a lowercase letter.")
  .refine((value) => /[A-Z]/.test(value), "Password must contain an uppercase letter.")
  .refine((value) => /[0-9]/.test(value), "Password must contain a number.");

export const uuidSchema = z.string().uuid();

/** Lowercase kebab-case, e.g. "ring-001". */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens.");

export const categoryIdSchema = slugSchema;

export const pieceStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export const imageKindSchema = z.enum(["STUDIO", "MODEL"]);

/* ── Auth ─────────────────────────────────────────────────────── */

export const loginSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing password only has to match, and applying
  // strength rules at login would leak which policy an account predates.
  password: z.string().min(1, "Enter your password.").max(200),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20, "This reset link is invalid.").max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(200),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Choose a password different from your current one.",
    path: ["newPassword"],
  });

/* ── Pieces ───────────────────────────────────────────────────── */

const stonesSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(12, "A piece can list at most 12 stones.")
  .transform((stones) => {
    // Dedupe case-insensitively while keeping the first spelling the admin typed.
    const seen = new Set<string>();
    return stones.filter((stone) => {
      const key = stone.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const createPieceSchema = z.object({
  /** Optional — derived from `name` when omitted. */
  slug: slugSchema.optional(),
  name: z.string().trim().min(2, "Give the piece a name.").max(120),
  category: categoryIdSchema,
  metal: z.string().trim().min(2).max(80),
  story: z.string().trim().min(1, "Write a short story for the piece.").max(2000),
  stones: stonesSchema.default([]),
  featured: z.boolean().default(false),
  status: pieceStatusSchema.default("PUBLISHED"),
  position: z.number().int().min(0).max(10_000).optional(),
});

/**
 * Every field optional, but the body may not be empty — an empty PATCH is
 * almost always a client bug, and silently returning 200 hides it.
 */
export const updatePieceSchema = createPieceSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  });

export const listPiecesQuerySchema = z.object({
  category: categoryIdSchema.optional(),
  /** Repeatable `?stone=` — matches pieces carrying every stone listed. */
  stone: z.union([z.string(), z.array(z.string())]).optional().transform((value) => {
    if (value === undefined) return undefined;
    const list = (Array.isArray(value) ? value : [value]).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }),
  featured: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")),
  /** Admin-only; public callers always get PUBLISHED regardless of what they ask. */
  status: pieceStatusSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

/**
 * `GET /api/stones`. Scoping to a category is the whole of it: the collection
 * page asks for the stones of the tab it is showing.
 */
export const listStonesQuerySchema = z.object({
  category: categoryIdSchema.optional(),
});

/* ── Public contact ───────────────────────────────────────────── */

/**
 * The enquiry form on the public site.
 *
 * `website` is a honeypot: the field is rendered but hidden from people, so
 * anything arriving with it filled in was submitted by a bot. It is accepted
 * rather than rejected by the schema — the route decides what to do with it,
 * and answering a bot with a validation error only tells it which field to
 * stop filling in.
 */
export const contactSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80),
  email: emailSchema,
  /** Optional and loosely checked: numbers are written a dozen valid ways. */
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  subject: z.string().trim().max(120).optional().or(z.literal("")),
  message: z.string().trim().min(10, "Tell us a little more — at least 10 characters.").max(4000),
  website: z.string().max(200).optional(),
});

/** The newsletter form. An address is the whole of it. */
export const newsletterSchema = z.object({
  email: emailSchema,
  website: z.string().max(200).optional(),
});

export const imageUploadFieldsSchema = z.object({
  kind: imageKindSchema.default("STUDIO"),
  alt: z.string().trim().max(200).optional(),
});

/**
 * A full restatement of a piece's gallery: every image id, in the order and
 * under the kind it should end up with. Sending the whole list rather than a
 * move-delta makes the operation idempotent and lets the server validate that
 * nothing was dropped or invented.
 */
export const reorderImagesSchema = z.object({
  images: z
    .array(z.object({ id: uuidSchema, kind: imageKindSchema, position: z.number().int().min(0) }))
    .min(1, "Provide the images to reorder.")
    .max(80),
});

/* ── Inferred types ───────────────────────────────────────────── */

export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreatePieceInput = z.infer<typeof createPieceSchema>;
export type UpdatePieceInput = z.infer<typeof updatePieceSchema>;
export type ListPiecesQuery = z.infer<typeof listPiecesQuerySchema>;
export type ListStonesQuery = z.infer<typeof listStonesQuerySchema>;
export type ReorderImagesInput = z.infer<typeof reorderImagesSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type NewsletterInput = z.infer<typeof newsletterSchema>;
