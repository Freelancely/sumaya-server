/**
 * Gallery management: upload, order, delete — and the cleanup that has to
 * happen on both sides of the storage boundary.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db/prisma.js";
import {
  app,
  createAdmin,
  NOT_AN_IMAGE,
  pieceInput,
  PNG_1X1,
  request,
  resetDatabase,
  seedCategories,
  signIn,
  storage,
  type SignedIn,
} from "./helpers.js";

let admin: SignedIn;
let pieceId: string;

beforeEach(async () => {
  await resetDatabase();
  await seedCategories();
  await createAdmin();
  admin = await signIn();

  const created = await request(app)
    .post("/api/pieces")
    .set(admin.auth)
    .send(pieceInput({ slug: "ring-001" }))
    .expect(201);
  pieceId = created.body.piece.pieceId;
});

/** Returns the supertest request itself, so a caller can chain `.expect(...)`. */
function upload(kind: "STUDIO" | "MODEL" = "STUDIO", alt?: string) {
  const pending = request(app).post("/api/pieces/ring-001/images").set(admin.auth).field("kind", kind);

  if (alt) pending.field("alt", alt);
  return pending.attach("file", PNG_1X1, "shot.png");
}

describe("POST /api/pieces/:id/images", () => {
  it("stores the asset and the row, numbering from zero within its kind", async () => {
    const first = await upload("STUDIO").expect(201);
    const second = await upload("STUDIO").expect(201);
    const model = await upload("MODEL").expect(201);

    expect(first.body.image.position).toBe(0);
    expect(second.body.image.position).toBe(1);
    // Positions are per kind, so the first model shot starts at zero again.
    expect(model.body.image.position).toBe(0);

    expect(first.body.image.url).toMatch(/^memory:\/\//);
    expect(storage().assets.size).toBe(3);
  });

  it("records the alt text", async () => {
    await upload("STUDIO", "A gold ring on linen").expect(201);

    const image = await prisma.pieceImage.findFirst();
    expect(image?.alt).toBe("A gold ring on linen");
  });

  it("refuses a file whose bytes are not a supported image, whatever it claims", async () => {
    const response = await request(app)
      .post("/api/pieces/ring-001/images")
      .set(admin.auth)
      // Declared as a PNG; the leading bytes say otherwise, and the bytes win.
      .attach("file", NOT_AN_IMAGE, { filename: "payload.png", contentType: "image/png" })
      .expect(415);

    expect(response.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(storage().assets.size).toBe(0);
    expect(await prisma.pieceImage.count()).toBe(0);
  });

  it("requires a file", async () => {
    const response = await request(app)
      .post("/api/pieces/ring-001/images")
      .set(admin.auth)
      .field("kind", "STUDIO")
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a request that is not multipart", async () => {
    await request(app)
      .post("/api/pieces/ring-001/images")
      .set(admin.auth)
      .send({ kind: "STUDIO" })
      .expect(400);
  });

  it("refuses an unknown piece before anything reaches storage", async () => {
    const response = await request(app)
      .post("/api/pieces/no-such-piece/images")
      .set(admin.auth)
      .attach("file", PNG_1X1, "shot.png")
      .expect(404);

    expect(response.body.error.code).toBe("PIECE_NOT_FOUND");
    expect(storage().assets.size).toBe(0);
  });

  it("refuses an anonymous caller", async () => {
    await request(app)
      .post("/api/pieces/ring-001/images")
      .attach("file", PNG_1X1, "shot.png")
      .expect(401);

    expect(storage().assets.size).toBe(0);
  });
});

describe("PATCH /api/pieces/:id/images/reorder", () => {
  it("renumbers from the submitted sequence, and can move an image between kinds", async () => {
    const first = (await upload("STUDIO").expect(201)).body.image;
    const second = (await upload("STUDIO").expect(201)).body.image;

    const response = await request(app)
      .patch("/api/pieces/ring-001/images/reorder")
      .set(admin.auth)
      .send({
        images: [
          // Deliberately sparse and out of order: the server owns the numbering
          // and reads the sequence, not the numbers.
          { id: second.id, kind: "STUDIO", position: 5 },
          { id: first.id, kind: "MODEL", position: 9 },
        ],
      })
      .expect(200);

    const images = response.body.piece.images;
    expect(images.find((image: { id: string }) => image.id === second.id)).toMatchObject({
      kind: "STUDIO",
      position: 0,
    });
    expect(images.find((image: { id: string }) => image.id === first.id)).toMatchObject({
      kind: "MODEL",
      position: 0,
    });
  });

  it("rejects a partial gallery", async () => {
    const first = (await upload("STUDIO").expect(201)).body.image;
    await upload("STUDIO").expect(201);

    const response = await request(app)
      .patch("/api/pieces/ring-001/images/reorder")
      .set(admin.auth)
      .send({ images: [{ id: first.id, kind: "STUDIO", position: 0 }] })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects an image id belonging to another piece", async () => {
    await upload("STUDIO").expect(201);

    await request(app).post("/api/pieces").set(admin.auth).send(pieceInput({ slug: "ring-002" })).expect(201);
    const other = await request(app)
      .post("/api/pieces/ring-002/images")
      .set(admin.auth)
      .attach("file", PNG_1X1, "shot.png")
      .expect(201);

    const response = await request(app)
      .patch("/api/pieces/ring-001/images/reorder")
      .set(admin.auth)
      .send({ images: [{ id: other.body.image.id, kind: "STUDIO", position: 0 }] })
      .expect(400);

    expect(response.body.error.details).toMatchObject({ unknownImageId: other.body.image.id });
  });

  it("refuses an anonymous caller", async () => {
    const image = (await upload("STUDIO").expect(201)).body.image;

    await request(app)
      .patch("/api/pieces/ring-001/images/reorder")
      .send({ images: [{ id: image.id, kind: "MODEL", position: 0 }] })
      .expect(401);
  });
});

describe("DELETE /api/images/:imageId", () => {
  it("removes the row and the stored asset, then closes the gap in positions", async () => {
    const first = (await upload("STUDIO").expect(201)).body.image;
    const second = (await upload("STUDIO").expect(201)).body.image;
    const third = (await upload("STUDIO").expect(201)).body.image;

    await request(app).delete(`/api/images/${first.id}`).set(admin.auth).expect(204);

    expect(storage().assets.size).toBe(2);

    const remaining = await prisma.pieceImage.findMany({
      where: { pieceId },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });
    // Dense 0..n-1 again: position 0 is the card thumbnail, so a gap would
    // silently promote nothing.
    expect(remaining).toEqual([
      { id: second.id, position: 0 },
      { id: third.id, position: 1 },
    ]);
  });

  it("answers 404 for an image that does not exist", async () => {
    const response = await request(app)
      .delete("/api/images/3f2504e0-4f89-11d3-9a0c-0305e82c3301")
      .set(admin.auth)
      .expect(404);

    expect(response.body.error.code).toBe("IMAGE_NOT_FOUND");
  });

  it("rejects an id that is not a uuid", async () => {
    const response = await request(app).delete("/api/images/not-a-uuid").set(admin.auth).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses an anonymous caller", async () => {
    const image = (await upload("STUDIO").expect(201)).body.image;

    await request(app).delete(`/api/images/${image.id}`).expect(401);
    expect(storage().assets.size).toBe(1);
  });
});

describe("deleting a piece", () => {
  it("keeps the photography on a soft delete — an accidental delete is recoverable", async () => {
    await upload("STUDIO").expect(201);

    await request(app).delete("/api/pieces/ring-001").set(admin.auth).expect(204);

    expect(storage().assets.size).toBe(1);
    expect(await prisma.pieceImage.count()).toBe(1);
  });

  it("destroys the photography on a purge", async () => {
    await upload("STUDIO").expect(201);
    await upload("MODEL").expect(201);

    await request(app).delete("/api/pieces/ring-001?purge=true").set(admin.auth).expect(204);

    expect(storage().assets.size).toBe(0);
    // The rows go with it, by cascade.
    expect(await prisma.pieceImage.count()).toBe(0);
  });
});

describe("the piece a public caller reads", () => {
  it("exposes studio and model urls in order, with the thumbnail alongside", async () => {
    await upload("STUDIO").expect(201);
    await upload("STUDIO").expect(201);
    await upload("MODEL").expect(201);

    const response = await request(app).get("/api/pieces/ring-001").expect(200);
    const piece = response.body.piece;

    expect(piece.studio).toHaveLength(2);
    expect(piece.model).toHaveLength(1);
    expect(piece.images.studio[0]).toMatchObject({
      url: expect.stringContaining("memory://"),
      thumbUrl: expect.stringContaining("memory://"),
      width: 1600,
      height: 1600,
    });
    // The provider's identity is an admin detail; it must not leak publicly.
    expect(piece.images.studio[0].publicId).toBeUndefined();
  });
});
