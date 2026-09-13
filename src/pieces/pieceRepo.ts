/**
 * Data access for the catalogue.
 *
 * Everything Prisma-shaped lives here so `PieceService` reads as business
 * rules, not queries. One detail worth stating: every read selects the same
 * `pieceInclude`, which is what lets a single serialiser produce the exact
 * `Piece` shape the frontend has consumed since the site was static.
 */
import type { Prisma } from "../db/generated/client.js";
import { prisma, type TransactionClient } from "../db/prisma.js";

/** The relation graph every piece response is built from. */
export const pieceInclude = {
  category: true,
  stones: { include: { stone: true }, orderBy: { position: "asc" } },
  images: { orderBy: [{ kind: "asc" }, { position: "asc" }] },
} satisfies Prisma.PieceInclude;

export type PieceWithRelations = Prisma.PieceGetPayload<{ include: typeof pieceInclude }>;

export interface ListFilters {
  categoryId?: string;
  /** Matches pieces carrying *all* of these stone slugs. */
  stoneSlugs?: string[];
  featured?: boolean;
  statuses: string[];
  search?: string;
  includeDeleted: boolean;
  page: number;
  perPage: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export class PieceRepository {
  private where(filters: ListFilters): Prisma.PieceWhereInput {
    return {
      ...(filters.includeDeleted ? {} : { deletedAt: null }),
      status: { in: filters.statuses as Prisma.EnumPieceStatusFilter["in"] },
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.featured === undefined ? {} : { featured: filters.featured }),
      // One `some` clause per stone — an AND of existence checks, which is what
      // "has all of these stones" means. A single `in` would be an OR.
      ...(filters.stoneSlugs?.length
        ? { AND: filters.stoneSlugs.map((slug) => ({ stones: { some: { stone: { slug } } } })) }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: "insensitive" } },
              { story: { contains: filters.search, mode: "insensitive" } },
              { metal: { contains: filters.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
  }

  async list(filters: ListFilters): Promise<PageResult<PieceWithRelations>> {
    const where = this.where(filters);

    // One round trip for the page and its count: the total is needed for
    // pagination and re-querying would double the latency.
    const [items, total] = await prisma.$transaction([
      prisma.piece.findMany({
        where,
        include: pieceInclude,
        orderBy: [{ position: "asc" }, { createdAt: "desc" }],
        skip: (filters.page - 1) * filters.perPage,
        take: filters.perPage,
      }),
      prisma.piece.count({ where }),
    ]);

    return {
      items,
      total,
      page: filters.page,
      perPage: filters.perPage,
      totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
    };
  }

  /**
   * Routes accept either the uuid or the human slug, so a link built from
   * either form keeps working.
   */
  async findByIdentifier(identifier: string, includeUnpublished: boolean): Promise<PieceWithRelations | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

    return prisma.piece.findFirst({
      where: {
        ...(isUuid ? { id: identifier } : { slug: identifier.toLowerCase() }),
        deletedAt: null,
        ...(includeUnpublished ? {} : { status: "PUBLISHED" }),
      },
      include: pieceInclude,
    });
  }

  async slugExists(slug: string, excludingId?: string): Promise<boolean> {
    const found = await prisma.piece.findFirst({
      where: { slug, ...(excludingId ? { id: { not: excludingId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  }

  async countInCategory(categoryId: string): Promise<number> {
    return prisma.piece.count({ where: { categoryId, deletedAt: null, status: "PUBLISHED" } });
  }

  /** Highest existing position, so a new piece lands at the end of its category. */
  async nextPosition(categoryId: string): Promise<number> {
    const last = await prisma.piece.findFirst({
      where: { categoryId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  }

  async requireById(id: string): Promise<PieceWithRelations | null> {
    return prisma.piece.findFirst({ where: { id, deletedAt: null }, include: pieceInclude });
  }

  /**
   * Resolves stone names to rows, creating any that are new.
   *
   * Matching is on a normalised slug so "Blue sapphire" and "blue  Sapphire"
   * converge on one row, which is what keeps the collection filter chips from
   * filling with near-duplicates.
   */
  async upsertStones(tx: TransactionClient, names: string[]): Promise<{ id: string; name: string }[]> {
    const resolved: { id: string; name: string }[] = [];

    for (const name of names) {
      const slug = slugifyStone(name);
      const stone = await tx.stone.upsert({
        where: { slug },
        // Existing rows keep the spelling they were first created with, so an
        // edit to one piece does not rewrite the label everywhere else.
        update: {},
        create: { slug, name },
        select: { id: true, name: true },
      });
      resolved.push(stone);
    }

    return resolved;
  }

  /** Removes stones no piece references any more, so the filter list stays honest. */
  async pruneOrphanStones(tx: TransactionClient): Promise<void> {
    await tx.stone.deleteMany({ where: { pieces: { none: {} } } });
  }
}

export function slugifyStone(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
