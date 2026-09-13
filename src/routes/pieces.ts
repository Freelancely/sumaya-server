/**
 * `/api/pieces` — the catalogue.
 *
 * The list is `auth: "optional"` rather than two separate endpoints: the admin
 * grid and the public collection want the same filtering and paging, and the
 * only real difference is whether drafts are visible and which serialiser runs.
 */
import { Router } from "express";
import { z } from "zod";

import { ValidationError } from "../http/errors.js";
import { assertSupportedImage, parseMultipart } from "../http/multipart.js";
import { RateLimits } from "../http/rateLimit.js";
import { created, noContent, ok, publicCache } from "../http/respond.js";
import { mount } from "../http/route.js";
import { getImageService, getPieceService, toAdminPiece, toPublicPiece } from "../pieces/index.js";
import {
  createPieceSchema,
  imageUploadFieldsSchema,
  listPiecesQuerySchema,
  reorderImagesSchema,
  updatePieceSchema,
} from "../validation/schemas.js";

export const piecesRouter: Router = Router();

/** The path parameter is the uuid **or** the human slug, so either link resolves. */
const identifierSchema = z.object({
  id: z.string().trim().min(1, "Provide a piece id or slug.").max(80),
});

/**
 * GET  /api/pieces   list the catalogue (public; richer when authenticated)
 * POST /api/pieces   create a piece (admin)
 */
mount(piecesRouter, "/", {
  GET: {
    auth: "optional",
    query: listPiecesQuerySchema,
    rateLimits: [{ rule: RateLimits.publicRead }],
    async handler({ res, requestId, query, user }) {
      const isAdmin = user !== null;
      const result = await getPieceService().list(query, isAdmin);

      // Anonymous responses are identical for everyone, so a cache in front of
      // the server can hold them. The route wrapper already set `no-store` for
      // authenticated callers.
      if (!isAdmin) publicCache(res, 60);

      ok(res, requestId, {
        pieces: isAdmin ? result.items.map(toAdminPiece) : result.items.map(toPublicPiece),
        pagination: {
          page: result.page,
          perPage: result.perPage,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
    },
  },

  POST: {
    auth: "required",
    body: createPieceSchema,
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ res, requestId, body }) {
      const piece = await getPieceService().create(body);
      created(res, requestId, { piece: toAdminPiece(piece) });
    },
  },
});

/**
 * GET    /api/pieces/:id   fetch one piece (public; drafts need auth)
 * PATCH  /api/pieces/:id   update it
 * DELETE /api/pieces/:id   soft-delete it, or `?purge=true` to destroy it
 */
mount(piecesRouter, "/:id", {
  GET: {
    auth: "optional",
    query: identifierSchema,
    rateLimits: [{ rule: RateLimits.publicRead }],
    async handler({ res, requestId, query, user }) {
      const isAdmin = user !== null;
      const piece = await getPieceService().get(query.id, isAdmin);

      if (!isAdmin) publicCache(res, 60);
      ok(res, requestId, { piece: isAdmin ? toAdminPiece(piece) : toPublicPiece(piece) });
    },
  },

  PATCH: {
    auth: "required",
    query: identifierSchema,
    body: updatePieceSchema,
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ res, requestId, query, body }) {
      const piece = await getPieceService().update(query.id, body);
      ok(res, requestId, { piece: toAdminPiece(piece) });
    },
  },

  DELETE: {
    auth: "required",
    query: identifierSchema.extend({
      /** Irreversible: removes the row and destroys the stored images. */
      purge: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    }),
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ res, requestId, query, logger, user }) {
      const service = getPieceService();

      if (query.purge) {
        // Resolve first: `purge` works by uuid, but the caller may have used a slug.
        const piece = await service.get(query.id, true);
        logger.warn("purge requested", { pieceId: piece.id, by: user!.id });
        await service.purge(piece.id);
      } else {
        await service.softDelete(query.id);
      }

      noContent(res, requestId);
    },
  },
});

/**
 * POST /api/pieces/:id/images — add one image to a piece's gallery.
 *
 * Multipart, so the body reaches busboy as a stream. The file is identified by
 * its magic bytes, not by the `Content-Type` the client claimed, before
 * anything is sent to storage.
 */
mount(piecesRouter, "/:id/images", {
  POST: {
    auth: "required",
    query: identifierSchema,
    rawBody: true,
    rateLimits: [{ rule: RateLimits.upload }],
    async handler({ req, res, requestId, query, rawBody }) {
      // The body is already being buffered by the route wrapper (see `rawBody`),
      // so resolving the piece first costs nothing and still rejects a bad id
      // before anything reaches storage.
      const piece = await getPieceService().get(query.id, true);

      const { fields, files } = await parseMultipart(req, rawBody!);
      const file = files[0];
      if (!file) throw new ValidationError("Attach an image file in the `file` field.");

      assertSupportedImage(file);
      const meta = imageUploadFieldsSchema.parse(fields);

      const image = await getImageService().upload({
        pieceId: piece.id,
        kind: meta.kind,
        alt: meta.alt,
        data: file.data,
        filename: file.filename,
      });

      created(res, requestId, { image });
    },
  },
});

/**
 * PATCH /api/pieces/:id/images/reorder
 *
 * Takes the whole gallery, not a move-delta: the client sends every image with
 * the kind and order it should end up in. That makes a retry harmless and lets
 * the server detect a client working from a stale gallery.
 */
mount(piecesRouter, "/:id/images/reorder", {
  PATCH: {
    auth: "required",
    query: identifierSchema,
    body: reorderImagesSchema,
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ res, requestId, query, body }) {
      const service = getPieceService();
      const piece = await service.get(query.id, true);

      await getImageService().reorder(piece.id, body);

      // Re-read so the response carries the normalised positions the server
      // settled on, rather than what the client proposed.
      ok(res, requestId, { piece: toAdminPiece(await service.get(piece.id, true)) });
    },
  },
});
