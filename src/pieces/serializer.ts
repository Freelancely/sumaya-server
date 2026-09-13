/**
 * Database rows → the API's public shape.
 *
 * The public shape is deliberately the `Piece` interface `src/content/pieces.ts`
 * has always exported, with `studio` and `model` as ordered URL arrays. That is
 * what lets the React components swap a static import for a fetch without a
 * single prop change.
 *
 * Admin responses add the fields the CMS needs — image ids, status, timestamps
 * — which is exactly why there are two serialisers rather than one with a flag
 * threaded through the components that consume it.
 */
import type { PieceWithRelations } from "./pieceRepo.js";

export interface PublicImage {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  alt: string | null;
}

export interface PublicPiece {
  id: string;
  name: string;
  category: string;
  stones: string[];
  metal: string;
  story: string;
  /** 1600px urls, in display order. */
  studio: string[];
  model: string[];
  featured: boolean;
  /** Full image records, for callers that want dimensions or the 800px variant. */
  images: { studio: PublicImage[]; model: PublicImage[] };
}

export interface AdminImage extends PublicImage {
  id: string;
  kind: "STUDIO" | "MODEL";
  position: number;
  publicId: string;
}

export interface AdminPiece extends Omit<PublicPiece, "images"> {
  /** The uuid. `id` stays the slug so both serialisers agree on identity. */
  pieceId: string;
  slug: string;
  status: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  images: AdminImage[];
}

function toPublicImage(image: PieceWithRelations["images"][number]): PublicImage {
  return {
    url: image.url,
    thumbUrl: image.thumbUrl,
    width: image.width,
    height: image.height,
    alt: image.alt,
  };
}

export function toPublicPiece(piece: PieceWithRelations): PublicPiece {
  // Already ordered by (kind, position) in `pieceInclude`, so partitioning
  // preserves the sequence the admin arranged.
  const studio = piece.images.filter((image) => image.kind === "STUDIO");
  const model = piece.images.filter((image) => image.kind === "MODEL");

  return {
    id: piece.slug,
    name: piece.name,
    category: piece.categoryId,
    stones: piece.stones.map((link) => link.stone.name),
    metal: piece.metal,
    story: piece.story,
    studio: studio.map((image) => image.url),
    model: model.map((image) => image.url),
    featured: piece.featured,
    images: { studio: studio.map(toPublicImage), model: model.map(toPublicImage) },
  };
}

export function toAdminPiece(piece: PieceWithRelations): AdminPiece {
  const { images: _images, ...rest } = toPublicPiece(piece);

  return {
    ...rest,
    pieceId: piece.id,
    slug: piece.slug,
    status: piece.status,
    position: piece.position,
    createdAt: piece.createdAt.toISOString(),
    updatedAt: piece.updatedAt.toISOString(),
    images: piece.images.map((image) => ({
      ...toPublicImage(image),
      id: image.id,
      kind: image.kind,
      position: image.position,
      publicId: image.publicId,
    })),
  };
}
