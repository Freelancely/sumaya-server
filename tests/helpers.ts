/**
 * What the test files build on: a clean database, an app, and a signed-in admin.
 *
 * Everything here talks to the real application — the real Express app, the
 * real services, the real Postgres. The only substitutes are the two seams the
 * production code already had: storage and mail.
 */
import type { Express } from "express";
import request from "supertest";

import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { hashPassword } from "../src/auth/password.js";
import { getMailer } from "../src/mail/providers.js";
import { MemoryMailer } from "../src/mail/providers.js";
import { getStorage, MemoryStorage } from "../src/storage/index.js";

export const app: Express = createApp();

/** The agent keeps cookies between requests, which is what the refresh flow needs. */
export function client() {
  return request.agent(app);
}

export { request };

export function mailbox(): MemoryMailer {
  const mailer = getMailer();
  if (!(mailer instanceof MemoryMailer)) throw new Error("Tests expect MAIL_DRIVER=memory.");
  return mailer;
}

export function storage(): MemoryStorage {
  const provider = getStorage();
  if (!(provider instanceof MemoryStorage)) throw new Error("Tests expect STORAGE_DRIVER=memory.");
  return provider;
}

export const CATEGORIES = [
  { id: "rings", label: "Rings", singular: "Ring", position: 0 },
  { id: "earrings", label: "Earrings", singular: "Earrings", position: 1 },
  { id: "necklaces", label: "Necklaces", singular: "Necklace", position: 2 },
  { id: "bracelets", label: "Bracelets", singular: "Bracelet", position: 3 },
];

export const ADMIN_EMAIL = "atelier@example.com";
export const ADMIN_PASSWORD = "Correct-Horse-9";

/**
 * Empties every table.
 *
 * `TRUNCATE ... CASCADE` in one statement rather than a delete per table: it
 * ignores foreign-key order, which means adding a model to the schema does not
 * quietly leave rows behind here.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      piece_images, piece_stones, stones, pieces, categories,
      sessions, password_reset_tokens, admin_users, rate_limits
    RESTART IDENTITY CASCADE
  `);
  mailbox().clear();
  storage().assets.clear();
}

export async function seedCategories(): Promise<void> {
  await prisma.category.createMany({ data: CATEGORIES });
}

export async function createAdmin(
  overrides: { email?: string; password?: string; isActive?: boolean; role?: "SUPERADMIN" | "ADMIN" } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = overrides.email ?? ADMIN_EMAIL;
  const password = overrides.password ?? ADMIN_PASSWORD;

  const user = await prisma.adminUser.create({
    data: {
      email,
      password: await hashPassword(password),
      name: "Test Admin",
      role: overrides.role ?? "SUPERADMIN",
      isActive: overrides.isActive ?? true,
    },
    select: { id: true, email: true },
  });

  return { ...user, password };
}

export interface SignedIn {
  accessToken: string;
  /** Ready to spread into `.set(...)`. */
  auth: { Authorization: string };
  agent: ReturnType<typeof client>;
  user: { id: string; email: string; role: string };
}

/** Creates the admin if it does not exist, then signs in through the real endpoint. */
export async function signIn(email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<SignedIn> {
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (!existing) await createAdmin({ email, password });

  const agent = client();
  const response = await agent.post("/api/auth/login").send({ email, password }).expect(200);

  return {
    accessToken: response.body.accessToken,
    auth: { Authorization: `Bearer ${response.body.accessToken}` },
    agent,
    user: response.body.user,
  };
}

/** A minimal valid piece body; override whichever field the test is about. */
export function pieceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Coral Bloom Ring",
    category: "rings",
    metal: "18k yellow gold",
    story: "Made for a summer wedding.",
    stones: ["Watermelon tourmaline"],
    ...overrides,
  };
}

/**
 * The smallest byte sequence that sniffs as a real PNG.
 *
 * A valid 1x1 PNG rather than random bytes, because the upload path decides the
 * type from the magic bytes and must see a genuine one.
 */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Leading bytes that are not any supported image, for the rejection path. */
export const NOT_AN_IMAGE = Buffer.from("#!/bin/sh\necho not an image\n".padEnd(64, " "), "utf8");
