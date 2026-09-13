/**
 * Catalogue business rules.
 *
 * Two invariants are worth calling out, because they are the reason most of
 * this code is inside a transaction:
 *
 *  1. **At most one featured piece per category.** The home teaser renders one
 *     piece per category, so featuring a second must unfeature the first — and
 *     it has to happen atomically, or a concurrent edit leaves two.
 *  2. **Stone links are replaced wholesale, not patched.** An update sends the
 *     full stone list; the service diffs it, and prunes stones that no longer
 *     belong to any piece so the filter chips stay accurate.
 */
import { ConflictError, ErrorCode, NotFoundError } from "../http/errors.js";
import { prisma, type TransactionClient } from "../db/prisma.js";
import { logger } from "../logging/logger.js";
import type { StorageProvider } from "../storage/StorageProvider.js";
import type { CreatePieceInput, ListPiecesQuery, UpdatePieceInput } from "../validation/schemas.js";
import { PieceRepository, type PageResult, type PieceWithRelations } from "./pieceRepo.js";

/** Public callers only ever see published work, whatever they ask for. */
const PUBLIC_STATUSES = ["PUBLISHED"];
const ADMIN_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"];

export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export class PieceService {
  constructor(
    private readonly repo: PieceRepository,
    private readonly storage: StorageProvider,
  ) {}

  /* ── Reads ──────────────────────────────────────────────────── */

  async list(query: ListPiecesQuery, isAdmin: boolean): Promise<PageResult<PieceWithRelations>> {
    // An anonymous caller passing `?status=DRAFT` gets published pieces, not an
    // error — the filter is simply not theirs to set.
    const statuses = isAdmin ? (query.status ? [query.status] : ADMIN_STATUSES) : PUBLIC_STATUSES;

    return this.repo.list({
      categoryId: query.category,
      stoneSlugs: query.stone?.map((name) => slugifyName(name)),
      featured: query.featured,
      statuses,
      search: query.search,
      includeDeleted: false,
      page: query.page,
      perPage: query.perPage,
    });
  }

  async get(identifier: string, isAdmin: boolean): Promise<PieceWithRelations> {
    const piece = await this.repo.findByIdentifier(identifier, isAdmin);
    if (!piece) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);
    return piece;
  }

  /* ── Writes ─────────────────────────────────────────────────── */

  async create(input: CreatePieceInput): Promise<PieceWithRelations> {
    const slug = await this.resolveSlug(input.slug ?? slugifyName(input.name));
    await this.assertCategoryExists(input.category);

    const position = input.position ?? (await this.repo.nextPosition(input.category));

    const created = await prisma.$transaction(async (tx) => {
      if (input.featured) await this.clearFeatured(tx, input.category);

      const stones = await this.repo.upsertStones(tx, input.stones);

      return tx.piece.create({
        data: {
          slug,
          name: input.name,
          categoryId: input.category,
          metal: input.metal,
          story: input.story,
          featured: input.featured,
          status: input.status,
          position,
          stones: {
            create: stones.map((stone, index) => ({ stoneId: stone.id, position: index })),
          },
        },
        select: { id: true },
      });
    });

    logger.info("piece created", { pieceId: created.id, slug });
    return this.requireById(created.id);
  }

  async update(identifier: string, input: UpdatePieceInput): Promise<PieceWithRelations> {
    const existing = await this.repo.findByIdentifier(identifier, true);
    if (!existing) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);

    const categoryId = input.category ?? existing.categoryId;
    if (input.category && input.category !== existing.categoryId) {
      await this.assertCategoryExists(input.category);
      // Only a *featured* piece leaving takes its category's representative
      // with it; moving an ordinary piece changes nothing about the home page.
      if (existing.featured) await this.assertNotLastFeatured(existing, existing.categoryId);
    }

    const slug = input.slug ? await this.resolveSlug(input.slug, existing.id) : undefined;

    // Unfeaturing the only featured piece in a category would break the home
    // teaser, which expects exactly one per category.
    if (input.featured === false && existing.featured) {
      // Checked against the category the piece is in *now* — that is the one
      // about to lose its featured piece.
      await this.assertNotLastFeatured(existing, existing.categoryId);
    }

    await prisma.$transaction(async (tx) => {
      if (input.featured === true) await this.clearFeatured(tx, categoryId, existing.id);

      if (input.stones) {
        const stones = await this.repo.upsertStones(tx, input.stones);
        // Replace rather than diff: the client sends the intended final list,
        // and a delete-then-create is both simpler and correct for ordering.
        await tx.pieceStone.deleteMany({ where: { pieceId: existing.id } });
        await tx.pieceStone.createMany({
          data: stones.map((stone, index) => ({ pieceId: existing.id, stoneId: stone.id, position: index })),
        });
      }

      await tx.piece.update({
        where: { id: existing.id },
        data: {
          ...(slug ? { slug } : {}),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.category === undefined ? {} : { categoryId: input.category }),
          ...(input.metal === undefined ? {} : { metal: input.metal }),
          ...(input.story === undefined ? {} : { story: input.story }),
          ...(input.featured === undefined ? {} : { featured: input.featured }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.position === undefined ? {} : { position: input.position }),
        },
      });

      if (input.stones) await this.repo.pruneOrphanStones(tx);
    });

    logger.info("piece updated", { pieceId: existing.id });
    return this.requireById(existing.id);
  }

  /**
   * Soft delete. The images stay in Cloudinary — an accidental delete is the
   * common case, and restoring a piece whose photography has been destroyed is
   * not a restore. `purge` is the deliberate, irreversible counterpart.
   */
  async softDelete(identifier: string): Promise<void> {
    const existing = await this.repo.findByIdentifier(identifier, true);
    if (!existing) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);

    if (existing.featured) await this.assertNotLastFeatured(existing, existing.categoryId);

    await prisma.piece.update({
      where: { id: existing.id },
      // Dropping the featured flag too: a deleted piece must not keep
      // representing its category on the home page.
      data: { deletedAt: new Date(), featured: false, status: "ARCHIVED" },
    });

    logger.info("piece soft-deleted", { pieceId: existing.id, slug: existing.slug });
  }

  /** Irreversible: removes the row and destroys every stored asset. */
  async purge(id: string): Promise<void> {
    const piece = await prisma.piece.findUnique({
      where: { id },
      include: { images: { select: { publicId: true } } },
    });
    if (!piece) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);

    const publicIds = piece.images.map((image) => image.publicId);

    // Rows first: cascade removes the image records, and an orphaned Cloudinary
    // asset is cheap to clean up later, whereas a row pointing at a destroyed
    // asset renders a broken image on the live site.
    await prisma.$transaction(async (tx) => {
      await tx.piece.delete({ where: { id } });
      await this.repo.pruneOrphanStones(tx);
    });

    await this.storage.destroyMany(publicIds);
    logger.warn("piece purged", { pieceId: id, assetsDestroyed: publicIds.length });
  }

  /* ── Invariants ─────────────────────────────────────────────── */

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) {
      throw new NotFoundError(`Unknown category "${categoryId}".`, ErrorCode.CATEGORY_NOT_FOUND);
    }
  }

  /** Demotes whichever piece currently represents the category. */
  private async clearFeatured(
    tx: TransactionClient,
    categoryId: string,
    exceptId?: string,
  ): Promise<void> {
    await tx.piece.updateMany({
      where: { categoryId, featured: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { featured: false },
    });
  }

  private async assertNotLastFeatured(piece: PieceWithRelations, categoryId: string): Promise<void> {
    const others = await prisma.piece.count({
      where: { categoryId, featured: true, deletedAt: null, id: { not: piece.id } },
    });

    if (others === 0 && (await this.repo.countInCategory(categoryId)) > 1) {
      throw new ConflictError(
        "Feature another piece in this category first — the home page needs one featured piece per category.",
        ErrorCode.FEATURED_REQUIRED,
      );
    }
  }

  private async resolveSlug(desired: string, excludingId?: string): Promise<string> {
    const slug = desired || "piece";
    if (await this.repo.slugExists(slug, excludingId)) {
      throw new ConflictError(`The slug "${slug}" is already in use.`, ErrorCode.SLUG_TAKEN);
    }
    return slug;
  }

  private async requireById(id: string): Promise<PieceWithRelations> {
    const piece = await this.repo.requireById(id);
    if (!piece) throw new NotFoundError("That piece does not exist.", ErrorCode.PIECE_NOT_FOUND);
    return piece;
  }
}
