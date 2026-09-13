/**
 * The taxonomy endpoint, and the counts the collection tabs render.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db/prisma.js";
import { app, createAdmin, pieceInput, request, resetDatabase, seedCategories, signIn } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  await seedCategories();
});

describe("GET /api/categories", () => {
  it("returns the active taxonomy in position order, with zero counts on an empty catalogue", async () => {
    const response = await request(app).get("/api/categories").expect(200);

    expect(response.body.categories).toEqual([
      { id: "rings", label: "Rings", singular: "Ring", count: 0 },
      { id: "earrings", label: "Earrings", singular: "Earrings", count: 0 },
      { id: "necklaces", label: "Necklaces", singular: "Necklace", count: 0 },
      { id: "bracelets", label: "Bracelets", singular: "Bracelet", count: 0 },
    ]);
    expect(response.headers["cache-control"]).toContain("s-maxage=300");
  });

  it("counts only published, undeleted pieces", async () => {
    await createAdmin();
    const admin = await signIn();

    await request(app).post("/api/pieces").set(admin.auth).send(pieceInput({ slug: "ring-001" })).expect(201);
    await request(app).post("/api/pieces").set(admin.auth).send(pieceInput({ slug: "ring-002" })).expect(201);
    await request(app)
      .post("/api/pieces")
      .set(admin.auth)
      .send(pieceInput({ slug: "ring-003", status: "DRAFT" }))
      .expect(201);
    await request(app).delete("/api/pieces/ring-002").set(admin.auth).expect(204);

    const response = await request(app).get("/api/categories").expect(200);
    const rings = response.body.categories.find((category: { id: string }) => category.id === "rings");

    // One published piece: the draft and the soft-deleted one do not count.
    expect(rings.count).toBe(1);
  });

  it("hides a deactivated category", async () => {
    await prisma.category.update({ where: { id: "bracelets" }, data: { isActive: false } });

    const response = await request(app).get("/api/categories").expect(200);
    expect(response.body.categories.map((category: { id: string }) => category.id)).not.toContain("bracelets");
  });
});
