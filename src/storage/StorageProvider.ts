/**
 * The image-storage seam.
 *
 * `ImageService` is written against this interface only, so moving off
 * Cloudinary is a new class and one line in the composition root — no change to
 * upload handling, validation, ordering, or cleanup.
 */
export interface UploadOptions {
  /** Groups assets under a stable path, e.g. the piece's slug. */
  folder: string;
  /** Filename hint. The provider still guarantees uniqueness. */
  filename?: string;
}

export interface StoredImage {
  /** Provider-side identity, needed to delete the asset later. */
  publicId: string;
  /** Display-size URL (long edge ~1600px). */
  url: string;
  /** Thumbnail URL (long edge ~800px), for cards and `srcSet`. */
  thumbUrl: string;
  width: number;
  height: number;
}

export interface StorageProvider {
  upload(data: Buffer, options: UploadOptions): Promise<StoredImage>;
  /** Must not throw when the asset is already gone — deletion is idempotent. */
  destroy(publicId: string): Promise<void>;
  destroyMany(publicIds: string[]): Promise<void>;
}
