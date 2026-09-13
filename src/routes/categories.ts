/**
 * GET /api/categories — the taxonomy, with live piece counts.
 *
 * Replaces the `categories` and `categoryCounts` exports the frontend reads
 * from `src/content/pieces.ts` today, in the same `{ id, label, singular }`
 * shape the tabs and chips already expect.
 */
import { Router } from "express";

import { prisma } from "../db/prisma.js";
import { RateLimits } from "../http/rateLimit.js";
import { ok, publicCache } from "../http/respond.js";
import { mount } from "../http/route.js";

export const categoriesRouter: Router = Router();

mount(categoriesRouter, "/", {
  GET: {
    auth: "optional",
    rateLimits: [{ rule: RateLimits.publicRead }],
    async handler({ res, requestId, user }) {
      const categories = await prisma.category.findMany({
        where: { isActive: true },
        orderBy: { position: "asc" },
        select: {
          id: true,
          label: true,
          singular: true,
          // Counted in the same query rather than one per category.
          _count: { select: { pieces: { where: { status: "PUBLISHED", deletedAt: null } } } },
        },
      });

      if (!user) publicCache(res, 300);

      ok(res, requestId, {
        categories: categories.map((category) => ({
          id: category.id,
          label: category.label,
          singular: category.singular,
          count: category._count.pieces,
        })),
      });
    },
  },
});
