/**
 * Gallery management for a piece.
 *
 * The ordering contract matters more than it looks: position 0 of the studio
 * set is the card thumbnail and position 0 of the model set is the hover image
 * on the collection grid. So positions are always renormalised to a dense
 * 0..n-1 run per kind — gaps would still render, but a later insert or move
 * would land somewhere the admin did not intend.
 */
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from "../http/errors.js";
import { prisma, type TransactionClient } from "../db/prisma.js";
import { logger } from "../logging/logger.js";
import type { StorageProvider } from "../storage/StorageProvider.js";
import type { ReorderImagesInput } from "../validation/schemas.js";

/** Generous for a jewellery gallery, low enough to bound a page's payload. */
const MAX_IMAGES_PER_PIECE = 40;

export type ImageKind = "STUDIO" | "MODEL";

export interface UploadImageCommand {
  pieceId: string;
  kind: ImageKind;
  alt?: string;
  data: Buffer;
  filename: string;
}

export class ImageService {
  constructor(private readonly storage: StorageProvider) {}

  async upload(command: UploadImageCommand): Promise<{ id: string; url: string; thumbUrl: string; position: number }> {
    const piece = await prisma.piece.findFirst({
      where: { id: command.pieceId, deletedAt: null },
      select: { id: true, slug: true, _count: { select: { images: true } } },
    });
    if (!piece) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);

    if (piece._count.images >= MAX_IMAGES_PER_PIECE) {
      throw new ConflictError(
        `A piece can hold at most ${MAX_IMAGES_PER_PIECE} images.`,
        ErrorCode.IMAGE_LIMIT_REACHED,
      );
    }

    const last = await prisma.pieceImage.findFirst({
      where: { pieceId: piece.id, kind: command.kind },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const position = (last?.position ?? -1) + 1;

    // Upload before writing the row: a failed upload should leave no trace,
    // whereas a row written first would point at an asset that never arrived.
    const stored = await this.storage.upload(command.data, {
      folder: piece.slug,
      filename: `${piece.slug}-${command.kind.toLowerCase()}-${position + 1}`,
    });

    try {
      const image = await prisma.pieceImage.create({
        data: {
          pieceId: piece.id,
          kind: command.kind,
          position,
          publicId: stored.publicId,
          url: stored.url,
          thumbUrl: stored.thumbUrl,
          width: stored.width,
          height: stored.height,
          alt: command.alt,
        },
        select: { id: true, url: true, thumbUrl: true, position: true },
      });

      logger.info("piece image uploaded", { pieceId: piece.id, imageId: image.id, kind: command.kind });
      return image;
    } catch (error) {
      // The row failed, so the asset we just stored is an orphan we can still
      // identify. Clean it up rather than pay for it forever.
      await this.storage.destroy(stored.publicId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Applies a complete restatement of a piece's gallery.
   *
   * The payload must name every image the piece has — that is what makes the
   * operation idempotent and lets us reject a stale client that is working from
   * a gallery someone else has since changed.
   */
  async reorder(pieceId: string, input: ReorderImagesInput): Promise<void> {
    const existing = await prisma.pieceImage.findMany({
      where: { pieceId },
      select: { id: true },
    });

    if (existing.length === 0) throw new NotFoundError("That piece has no images.", ErrorCode.IMAGE_NOT_FOUND);

    const existingIds = new Set(existing.map((image) => image.id));
    const submittedIds = new Set(input.images.map((image) => image.id));

    for (const id of submittedIds) {
      if (!existingIds.has(id)) {
        throw new ValidationError("The gallery has changed. Reload and try again.", { unknownImageId: id });
      }
    }
    if (submittedIds.size !== existing.length) {
      throw new ValidationError("List every image in the piece when reordering.", {
        expected: existing.length,
        received: submittedIds.size,
      });
    }

    // Renormalise from the submitted order rather than trusting the positions
    // sent: the client expresses intent by sequence, and we own the numbering.
    const byKind = new Map<ImageKind, string[]>([
      ["STUDIO", []],
      ["MODEL", []],
    ]);

    for (const image of [...input.images].sort((a, b) => a.position - b.position)) {
      byKind.get(image.kind)!.push(image.id);
    }

    await prisma.$transaction(async (tx) => {
      // Sequential rather than Promise.all: an interactive transaction runs on
      // one connection, so parallel writes only add contention.
      for (const [kind, ids] of byKind) {
        for (const [index, id] of ids.entries()) {
          await tx.pieceImage.update({ where: { id }, data: { kind, position: index } });
        }
      }
    });

    logger.info("piece gallery reordered", { pieceId, images: input.images.length });
  }

  async remove(imageId: string): Promise<void> {
    const image = await prisma.pieceImage.findUnique({
      where: { id: imageId },
      select: { id: true, pieceId: true, kind: true, publicId: true },
    });
    if (!image) throw new NotFoundError("That image does not exist.", ErrorCode.IMAGE_NOT_FOUND);

    // The asset goes first: if this throws, the row survives and the admin can
    // retry. The reverse order would leave a paid-for asset nothing references.
    await this.storage.destroy(image.publicId);

    await prisma.$transaction(async (tx) => {
      await tx.pieceImage.delete({ where: { id: image.id } });
      await this.closeGaps(tx, image.pieceId, image.kind as ImageKind);
    });

    logger.info("piece image removed", { pieceId: image.pieceId, imageId: image.id });
  }

  /** Rewrites positions to a dense 0..n-1 run after a removal. */
  private async closeGaps(tx: TransactionClient, pieceId: string, kind: ImageKind): Promise<void> {
    const remaining = await tx.pieceImage.findMany({
      where: { pieceId, kind },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });

    // Pair each row with the index it should occupy *before* filtering, so a
    // delete from the end of the list does not rewrite the whole gallery.
    const moved = remaining
      .map((image, index) => ({ image, index }))
      .filter(({ image, index }) => image.position !== index);

    for (const { image, index } of moved) {
      await tx.pieceImage.update({ where: { id: image.id }, data: { position: index } });
    }
  }
}
