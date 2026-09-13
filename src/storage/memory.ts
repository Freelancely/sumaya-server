/**
 * In-process `StorageProvider`.
 *
 * Exists so the upload, ordering and cleanup paths can be exercised — by a test
 * or by someone working offline — without a Cloudinary account or a network
 * round trip. It is refused in production by the environment schema: everything
 * it holds dies with the process.
 */
import { createHash, randomUUID } from "node:crypto";

import type { StorageProvider, StoredImage, UploadOptions } from "./StorageProvider.js";

export interface StoredAsset extends StoredImage {
  data: Buffer;
}

export class MemoryStorage implements StorageProvider {
  /** Keyed by `publicId`, so a test can assert what survived a delete. */
  readonly assets = new Map<string, StoredAsset>();

  async upload(data: Buffer, options: UploadOptions): Promise<StoredImage> {
    // A suffix, as Cloudinary does, so re-uploading the same filename does not
    // silently replace the earlier asset.
    const publicId = `${options.folder}/${options.filename ?? "upload"}-${randomUUID().slice(0, 8)}`;
    // Deterministic in the content, so the same bytes always yield the same
    // URL — which makes an assertion on it readable.
    const digest = createHash("sha256").update(data).digest("hex").slice(0, 12);

    const stored: StoredAsset = {
      publicId,
      url: `memory://${publicId}/1600-${digest}.webp`,
      thumbUrl: `memory://${publicId}/800-${digest}.webp`,
      width: 1600,
      height: 1600,
      data,
    };

    this.assets.set(publicId, stored);
    const { data: _data, ...image } = stored;
    return image;
  }

  /** Idempotent, matching the interface: an asset already gone is success. */
  async destroy(publicId: string): Promise<void> {
    this.assets.delete(publicId);
  }

  async destroyMany(publicIds: string[]): Promise<void> {
    for (const id of publicIds) this.assets.delete(id);
  }
}
