/**
 * Idempotent bootstrap: the four categories, and the first superadmin.
 *
 * There is no public signup — the site has exactly one operator — so this is
 * the only path that creates an account. Running it twice is safe: categories
 * are upserted, and an existing admin keeps the password they already have
 * rather than being silently reset from whatever is in the current `.env`.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

import { PrismaClient } from "../src/db/generated/client.js";

const CATEGORIES = [
  { id: "rings", label: "Rings", singular: "Ring", position: 0 },
  { id: "earrings", label: "Earrings", singular: "Earrings", position: 1 },
  { id: "necklaces", label: "Necklaces", singular: "Necklace", position: 2 },
  { id: "bracelets", label: "Bracelets", singular: "Bracelet", position: 3 },
];

const MIN_PASSWORD_LENGTH = 12;

function connectionString(): string {
  // `||` so an empty DIRECT_URL falls through rather than winning.
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (and ideally DIRECT_URL) before seeding.");
  return url;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });

  try {
    for (const category of CATEGORIES) {
      await prisma.category.upsert({
        where: { id: category.id },
        // Labels are safe to refresh; `isActive` is left alone so a category
        // hidden by hand is not resurrected by a re-seed.
        update: { label: category.label, singular: category.singular, position: category.position },
        create: category,
      });
    }
    console.log(`✓ ${CATEGORIES.length} categories ready`);

    const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SUPERADMIN_PASSWORD;

    if (!email || !password) {
      console.log("• SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD not set — skipping admin seed");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`SUPERADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (Buffer.byteLength(password, "utf8") > 72) {
      // bcrypt truncates beyond 72 bytes, so a longer value would not be the
      // password it appears to be.
      throw new Error("SUPERADMIN_PASSWORD must be at most 72 bytes.");
    }

    const existing = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      console.log(`• Superadmin ${email} already exists — password left unchanged`);
      return;
    }

    await prisma.adminUser.create({
      data: {
        email,
        password: await bcrypt.hash(password, 12),
        name: process.env.SUPERADMIN_NAME?.trim() || "Superadmin",
        role: "SUPERADMIN",
      },
    });

    console.log(`✓ Superadmin created: ${email}`);
    console.log("  Sign in, change this password, then remove SUPERADMIN_PASSWORD from your .env.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
