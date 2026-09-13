/**
 * The catalogue: what a public caller may see, and what an admin may change.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db/prisma.js";
import {
  app,
  createAdmin,
  pieceInput,
  request,
  resetDatabase,
  seedCategories,
  signIn,
  type SignedIn,
} from "./helpers.js";

let admin: SignedIn;

beforeEach(async () => {
  await resetDatabase();
  await seedCategories();
  await createAdmin();
  admin = await signIn();
});

/** Creates a piece through the API, which is also what exercises the write path. */
async function create(overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await request(app)
    .post("/api/pieces")
    .set(admin.auth)
    .send(pieceInput(overrides))
    .expect(201);
  return response.body.piece;
}

describe("POST /api/pieces", () => {
  it("creates a piece, deriving the slug from the name", async () => {
    const piece = await create({ name: "Coral Bloom Ring" });

    expect(piece.slug).toBe("coral-bloom-ring");
    expect(piece.id).toBe("coral-bloom-ring");
    expect(piece.pieceId).toEqual(expect.any(String));
    expect(piece.status).toBe("PUBLISHED");
    expect(piece.stones).toEqual(["Watermelon tourmaline"]);
    expect(piece.images).toEqual([]);
  });

  it("accepts an explicit slug and refuses one already taken", async () => {
    await create({ slug: "ring-001" });

    const conflict = await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-001", name: "Another Ring" }))
      .expect(409);

    expect(conflict.body.error.code).toBe("SLUG_TAKEN");
  });

  it("refuses an unknown category", async () => {
    const response = await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ category: "tiaras" }))
      .expect(404);

    expect(response.body.error.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("dedupes stones case-insensitively, keeping the first spelling", async () => {
    const piece = await create({ stones: ["Ruby", "ruby", "  RUBY  ", "Opal"] });
    expect(piece.stones).toEqual(["Ruby", "Opal"]);
  });

  it("appends to the end of its category", async () => {
    const first = await create({ name: "First Ring" });
    const second = await create({ name: "Second Ring" });

    expect(second.position).toBe(first.position + 1);
  });

  it("refuses an anonymous caller", async () => {
    await request(app).post("/api/pieces").send(pieceInput()).expect(401);
  });

  it("rejects a payload missing required fields", async () => {
    const response = await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send({ name: "x" })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /api/pieces", () => {
  beforeEach(async () => {
    await create({ name: "Alpha Ring", slug: "ring-001", stones: ["Ruby"], featured: true });
    await create({ name: "Beta Ring", slug: "ring-002", stones: ["Ruby", "Opal"] });
    await create({ name: "Draft Ring", slug: "ring-003", status: "DRAFT" });
    await create({ name: "Gamma Necklace", slug: "neck-001", category: "necklaces", stones: ["Opal"] });
  });

  it("shows a public caller only published pieces, in the frontend's shape", async () => {
    const response = await request(app).get("/api/pieces").expect(200);

    const slugs = response.body.pieces.map((piece: { id: string }) => piece.id);
    expect(slugs).not.toContain("ring-003");
    expect(response.body.pagination.total).toBe(3);

    const first = response.body.pieces[0];
    // The exact `Piece` shape the static site already consumed.
    expect(Object.keys(first).sort()).toEqual(
      ["category", "featured", "id", "images", "metal", "model", "name", "stones", "story", "studio"].sort(),
    );
    // Admin-only fields must not leak to an anonymous caller.
    expect(first.status).toBeUndefined();
    expect(first.pieceId).toBeUndefined();
  });

  it("shows an authenticated caller the drafts and the admin shape", async () => {
    const response = await request(app).get("/api/pieces").set(admin.auth).expect(200);

    const slugs = response.body.pieces.map((piece: { slug: string }) => piece.slug);
    expect(slugs).toContain("ring-003");
    expect(response.body.pieces[0].pieceId).toEqual(expect.any(String));
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("ignores a status filter from a public caller rather than erroring", async () => {
    const response = await request(app).get("/api/pieces?status=DRAFT").expect(200);

    // The filter is simply not theirs to set: published work, not an error.
    expect(response.body.pieces).toHaveLength(3);
    expect(response.body.pieces.every((piece: { id: string }) => piece.id !== "ring-003")).toBe(true);
  });

  it("honours a status filter from an admin", async () => {
    const response = await request(app).get("/api/pieces?status=DRAFT").set(admin.auth).expect(200);

    expect(response.body.pieces).toHaveLength(1);
    expect(response.body.pieces[0].slug).toBe("ring-003");
  });

  it("filters by category", async () => {
    const response = await request(app).get("/api/pieces?category=necklaces").expect(200);
    expect(response.body.pieces.map((piece: { id: string }) => piece.id)).toEqual(["neck-001"]);
  });

  it("requires every stone listed, not any of them", async () => {
    const both = await request(app).get("/api/pieces?stone=Ruby&stone=Opal").expect(200);
    expect(both.body.pieces.map((piece: { id: string }) => piece.id)).toEqual(["ring-002"]);

    const one = await request(app).get("/api/pieces?stone=Ruby").expect(200);
    expect(one.body.pieces).toHaveLength(2);
  });

  it("filters by featured", async () => {
    const response = await request(app).get("/api/pieces?featured=true").expect(200);
    expect(response.body.pieces.map((piece: { id: string }) => piece.id)).toEqual(["ring-001"]);
  });

  it("searches name, story and metal", async () => {
    const byName = await request(app).get("/api/pieces?search=gamma").expect(200);
    expect(byName.body.pieces.map((piece: { id: string }) => piece.id)).toEqual(["neck-001"]);

    const byMetal = await request(app).get("/api/pieces?search=yellow%20gold").expect(200);
    expect(byMetal.body.pieces.length).toBe(3);
  });

  it("pages, and reports the totals a pager needs", async () => {
    const page = await request(app).get("/api/pieces?page=2&perPage=2").expect(200);

    expect(page.body.pieces).toHaveLength(1);
    expect(page.body.pagination).toEqual({ page: 2, perPage: 2, total: 3, totalPages: 2 });
  });

  it("rejects a page size beyond the cap", async () => {
    const response = await request(app).get("/api/pieces?perPage=500").expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /api/pieces/:id", () => {
  it("resolves by slug and by uuid alike", async () => {
    const piece = await create({ slug: "ring-001" });

    const bySlug = await request(app).get("/api/pieces/ring-001").expect(200);
    const byUuid = await request(app).get(`/api/pieces/${piece.pieceId}`).expect(200);

    expect(bySlug.body.piece.id).toBe("ring-001");
    expect(byUuid.body.piece.id).toBe("ring-001");
  });

  it("hides a draft from a public caller but shows it to an admin", async () => {
    await create({ slug: "ring-003", status: "DRAFT" });

    const anonymous = await request(app).get("/api/pieces/ring-003").expect(404);
    expect(anonymous.body.error.code).toBe("PIECE_NOT_FOUND");

    await request(app).get("/api/pieces/ring-003").set(admin.auth).expect(200);
  });

  it("answers 404 for a piece that does not exist", async () => {
    const response = await request(app).get("/api/pieces/no-such-piece").expect(404);
    expect(response.body.error.code).toBe("PIECE_NOT_FOUND");
  });
});

describe("PATCH /api/pieces/:id", () => {
  it("updates only the fields sent", async () => {
    const piece = await create({ slug: "ring-001", name: "Original" });

    const response = await request(app)
      .patch("/api/pieces/ring-001")
      .set(admin.auth)
      .send({ name: "Renamed" })
      .expect(200);

    expect(response.body.piece.name).toBe("Renamed");
    // Untouched fields keep their values, and the slug does not follow the name.
    expect(response.body.piece.slug).toBe("ring-001");
    expect(response.body.piece.metal).toBe(piece.metal);
  });

  it("replaces the stone list wholesale and prunes what nothing references", async () => {
    await create({ slug: "ring-001", stones: ["Ruby", "Opal"] });

    const response = await request(app)
      .patch("/api/pieces/ring-001")
      .set(admin.auth)
      .send({ stones: ["Emerald"] })
      .expect(200);

    expect(response.body.piece.stones).toEqual(["Emerald"]);

    // Ruby and Opal now belong to no piece, so the filter chips must lose them.
    const remaining = await prisma.stone.findMany({ select: { name: true } });
    expect(remaining.map((stone) => stone.name)).toEqual(["Emerald"]);
  });

  it("rejects an empty body", async () => {
    await create({ slug: "ring-001" });

    const response = await request(app).patch("/api/pieces/ring-001").set(admin.auth).send({}).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses an anonymous caller", async () => {
    await create({ slug: "ring-001" });
    await request(app).patch("/api/pieces/ring-001").send({ name: "Hijacked" }).expect(401);
  });

  describe("the one-featured-piece-per-category rule", () => {
    it("demotes the previous representative when another is featured", async () => {
      await create({ slug: "ring-001", name: "First", featured: true });
      await create({ slug: "ring-002", name: "Second" });

      await request(app).patch("/api/pieces/ring-002").set(admin.auth).send({ featured: true }).expect(200);

      const first = await request(app).get("/api/pieces/ring-001").expect(200);
      expect(first.body.piece.featured).toBe(false);
    });

    it("refuses to leave a populated category with no featured piece", async () => {
      await create({ slug: "ring-001", name: "First", featured: true });
      await create({ slug: "ring-002", name: "Second" });

      const response = await request(app)
        .patch("/api/pieces/ring-001")
        .set(admin.auth)
        .send({ featured: false })
        .expect(409);

      expect(response.body.error.code).toBe("FEATURED_REQUIRED");
    });

    it("allows unfeaturing the only piece in a category", async () => {
      await create({ slug: "neck-001", category: "necklaces", featured: true });

      await request(app).patch("/api/pieces/neck-001").set(admin.auth).send({ featured: false }).expect(200);
    });
  });
});

describe("DELETE /api/pieces/:id", () => {
  it("soft-deletes: the row survives, the public listing does not show it", async () => {
    const piece = await create({ slug: "ring-001" });

    await request(app).delete("/api/pieces/ring-001").set(admin.auth).expect(204);

    const row = await prisma.piece.findUnique({ where: { id: piece.pieceId } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.status).toBe("ARCHIVED");
    // A deleted piece must not keep representing its category.
    expect(row?.featured).toBe(false);

    const listing = await request(app).get("/api/pieces").expect(200);
    expect(listing.body.pieces).toHaveLength(0);
    await request(app).get("/api/pieces/ring-001").expect(404);
  });

  it("purges on request, removing the row entirely", async () => {
    const piece = await create({ slug: "ring-001" });

    await request(app).delete("/api/pieces/ring-001?purge=true").set(admin.auth).expect(204);

    expect(await prisma.piece.findUnique({ where: { id: piece.pieceId } })).toBeNull();
  });

  it("refuses an anonymous caller", async () => {
    await create({ slug: "ring-001" });
    await request(app).delete("/api/pieces/ring-001").expect(401);

    expect(await prisma.piece.count()).toBe(1);
  });
});
