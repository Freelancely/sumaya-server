/**
 * Cloudinary-backed `StorageProvider`.
 *
 * The two derivative sizes reproduce what `scripts/optimise-images.mjs` builds
 * locally today — 1600px and 800px webp — so the frontend's existing `srcSet`
 * pattern keeps working, just against real URLs instead of a filename that had
 * `-1600` swapped for `-800`.
 *
 * `eager` transformations are requested at upload time rather than on first
 * view, so the first visitor after an admin adds a piece is not the one who
 * pays for the transform.
 */
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

import { env } from "../config/env.js";
import { ExternalServiceError } from "../http/errors.js";
import { describeError, logger } from "../logging/logger.js";
import type { StorageProvider, StoredImage, UploadOptions } from "./StorageProvider.js";

export const DISPLAY_WIDTH = 1600;
export const THUMB_WIDTH = 800;

let configured = false;

function configure(): void {
  if (configured) return;
  // Non-null: the env schema refuses to start with STORAGE_DRIVER=cloudinary
  // and any of these missing, so reaching here without them is impossible.
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME!,
    api_key: env.CLOUDINARY_API_KEY!,
    api_secret: env.CLOUDINARY_API_SECRET!,
    secure: true,
  });
  configured = true;
}

/** `limit` never upscales, so a smaller source is stored at its own size. */
const derivative = (width: number) => ({
  width,
  crop: "limit" as const,
  quality: "auto:good",
  fetch_format: "webp",
});

export class CloudinaryStorage implements StorageProvider {
  async upload(data: Buffer, options: UploadOptions): Promise<StoredImage> {
    configure();

    const response = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${env.CLOUDINARY_FOLDER}/${options.folder}`,
          public_id: options.filename,
          // Cloudinary would otherwise overwrite an existing asset with the
          // same public_id; a suffix keeps re-uploads of the same filename
          // from silently replacing an earlier image.
          unique_filename: true,
          overwrite: false,
          resource_type: "image",
          // Strip camera metadata: client photography can carry location.
          invalidate: true,
          eager: [derivative(DISPLAY_WIDTH), derivative(THUMB_WIDTH)],
          eager_async: false,
        },
        (error, result) => {
          if (error || !result) reject(error ?? new Error("Cloudinary returned no result."));
          else resolve(result);
        },
      );
      stream.end(data);
    }).catch((error: unknown) => {
      logger.error("Cloudinary upload failed", describeError(error));
      throw new ExternalServiceError("image storage", error);
    });

    // Fall back to the original URL if an eager transform is missing, so a
    // partial Cloudinary response still yields a usable record.
    const [display, thumb] = response.eager ?? [];

    return {
      publicId: response.public_id,
      url: display?.secure_url ?? response.secure_url,
      thumbUrl: thumb?.secure_url ?? display?.secure_url ?? response.secure_url,
      width: response.width,
      height: response.height,
    };
  }

  /**
   * Deliberately forgiving: an asset that is already gone is the state we
   * wanted, and failing here would strand the database row we are deleting
   * alongside it.
   */
  async destroy(publicId: string): Promise<void> {
    configure();

    try {
      const result = await cloudinary.uploader.destroy(publicId, { invalidate: true });
      if (result.result !== "ok" && result.result !== "not found") {
        logger.warn("Cloudinary reported an unexpected delete result", { publicId, result: result.result });
      }
    } catch (error) {
      logger.error("Cloudinary delete failed", { publicId, ...describeError(error) });
      throw new ExternalServiceError("image storage", error);
    }
  }

  /**
   * Best-effort bulk cleanup. One failure must not abandon the rest, so results
   * are settled and only logged — callers use this when the rows are already
   * gone and the assets are orphans either way.
   */
  async destroyMany(publicIds: string[]): Promise<void> {
    if (publicIds.length === 0) return;

    const results = await Promise.allSettled(publicIds.map((id) => this.destroy(id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      logger.warn("some assets could not be deleted from storage", { total: publicIds.length, failed });
    }
  }
}
