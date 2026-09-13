/**
 * The stone facet the collection page renders its filter chips from.
 *
 * The point of the endpoint is that it describes the whole catalogue rather
 * than one page of it, so the cases below are mostly about what must *not*
 * reach a chip: drafts, soft-deleted pieces, and stones from a category the
 * visitor is not looking at.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { app, createAdmin, pieceInput, request, resetDatabase, seedCategories, signIn } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  await seedCategories();
});

describe("GET /api/stones", () => {
  it("is empty on an empty catalogue, and cacheable for anonymous callers", async () => {
    const response = await request(app).get("/api/stones").expect(200);

    expect(response.body.stones).toEqual([]);
    expect(response.headers["cache-control"]).toContain("s-maxage=300");
  });

  it("returns each stone once, alphabetically, with the number of pieces carrying it", async () => {
    await createAdmin();
    const admin = await signIn();

    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-001", stones: ["Emerald", "Diamond"] }))
      .expect(201);
    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-002", stones: ["Emerald"] }))
      .expect(201);

    const response = await request(app).get("/api/stones").expect(200);

    expect(response.body.stones).toEqual([
      { slug: "diamond", name: "Diamond", count: 1 },
      { slug: "emerald", name: "Emerald", count: 2 },
    ]);
  });

  it("counts only published, undeleted pieces", async () => {
    await createAdmin();
    const admin = await signIn();

    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-001", stones: ["Emerald"] }))
      .expect(201);
    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-002", stones: ["Emerald"] }))
      .expect(201);
    // A draft, and a stone only the draft carries.
    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-003", status: "DRAFT", stones: ["Sapphire"] }))
      .expect(201);
    await request(app).delete("/api/pieces/ring-002").set(admin.auth).expect(204);

    const response = await request(app).get("/api/stones").expect(200);

    // A chip the public grid would answer with nothing must not be offered.
    expect(response.body.stones).toEqual([{ slug: "emerald", name: "Emerald", count: 1 }]);
  });

  it("scopes to a category, so a tab only offers stones it actually has", async () => {
    await createAdmin();
    const admin = await signIn();

    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-001", category: "rings", stones: ["Emerald"] }))
      .expect(201);
    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "necklace-001", category: "necklaces", stones: ["Tanzanite"] }))
      .expect(201);

    const rings = await request(app).get("/api/stones").query({ category: "rings" }).expect(200);
    expect(rings.body.stones).toEqual([{ slug: "emerald", name: "Emerald", count: 1 }]);

    const all = await request(app).get("/api/stones").expect(200);
    expect(all.body.stones.map((stone: { slug: string }) => stone.slug)).toEqual(["emerald", "tanzanite"]);
  });

  it("filtering the catalogue by a slug this endpoint returned finds the pieces", async () => {
    await createAdmin();
    const admin = await signIn();

    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-001", stones: ["Watermelon tourmaline"] }))
      .expect(201);

    const stones = await request(app).get("/api/stones").expect(200);
    const [stone] = stones.body.stones;
    expect(stone.slug).toBe("watermelon-tourmaline");

    // The chip sends the slug, not the display name — the round trip is the
    // whole contract between the two endpoints.
    const pieces = await request(app).get("/api/pieces").query({ stone: stone.slug }).expect(200);
    expect(pieces.body.pieces.map((piece: { id: string }) => piece.id)).toEqual(["ring-001"]);
  });

  it("rejects a category that is not a slug", async () => {
    await request(app).get("/api/stones").query({ category: "Not A Slug!" }).expect(400);
  });
});
