/**
 * GET /api/stones — the stone vocabulary, with live piece counts.
 *
 * The collection page used to derive its filter chips from whichever pieces
 * happened to be loaded, which made the list grow as the visitor paged through
 * and meant a stone only present on page four was unfilterable until they got
 * there. Paged responses cannot carry a facet, so the facet is its own read.
 *
 * `?category=` scopes the counts to one tab, so selecting "Rings" offers only
 * the stones that actually appear in rings — a chip that would return nothing
 * is never shown.
 */
import { Router } from "express";

import { prisma } from "../db/prisma.js";
import { RateLimits } from "../http/rateLimit.js";
import { ok, publicCache } from "../http/respond.js";
import { mount } from "../http/route.js";
import { listStonesQuerySchema } from "../validation/schemas.js";

export const stonesRouter: Router = Router();

mount(stonesRouter, "/", {
  GET: {
    auth: "optional",
    query: listStonesQuerySchema,
    rateLimits: [{ rule: RateLimits.publicRead }],
    async handler({ res, requestId, query, user }) {
      // Published only, for everyone. The chips sit on the public collection
      // page, and an admin browsing it must not see a stone that only a draft
      // carries — the grid beside it would come back empty.
      const pieces = {
        status: "PUBLISHED" as const,
        deletedAt: null,
        ...(query.category ? { categoryId: query.category } : {}),
      };

      const stones = await prisma.stone.findMany({
        where: { pieces: { some: { piece: pieces } } },
        // Ordered by the slug, not the display name: Postgres sorts uppercase
        // before lowercase, which dropped every stone an admin happened to type
        // in lower case ("watermeloon") to the end of the chips. The slug is
        // already case- and space-normalised, so ordering on it is the
        // alphabetical order a reader expects.
        orderBy: { slug: "asc" },
        select: {
          slug: true,
          name: true,
          // Filtered relation count, so the number beside a chip is the number
          // of pieces the chip would actually return under the active tab.
          _count: { select: { pieces: { where: { piece: pieces } } } },
        },
      });

      if (!user) publicCache(res, 300);

      ok(res, requestId, {
        stones: stones.map((stone) => ({
          slug: stone.slug,
          name: stone.name,
          count: stone._count.pieces,
        })),
      });
    },
  },
});
