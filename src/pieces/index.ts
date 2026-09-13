/**
 * Composition root for the catalogue.
 *
 * Concrete implementations are bound to interfaces here so routes import a
 * ready service and never learn that storage happens to be Cloudinary.
 */
import { getStorage } from "../storage/index.js";
import { ImageService } from "./imageService.js";
import { PieceRepository } from "./pieceRepo.js";
import { PieceService } from "./pieceService.js";

let pieceService: PieceService | undefined;
let imageService: ImageService | undefined;

export function getPieceService(): PieceService {
  pieceService ??= new PieceService(new PieceRepository(), getStorage());
  return pieceService;
}

export function getImageService(): ImageService {
  imageService ??= new ImageService(getStorage());
  return imageService;
}

export { ImageService } from "./imageService.js";
export { PieceRepository } from "./pieceRepo.js";
export { PieceService } from "./pieceService.js";
export { toAdminPiece, toPublicPiece } from "./serializer.js";
export type { AdminPiece, PublicPiece } from "./serializer.js";
