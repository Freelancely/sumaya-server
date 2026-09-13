/**
 * Picks the storage implementation named by `STORAGE_DRIVER` and holds it.
 *
 * Everything upstream depends on `StorageProvider`, so this is the only file
 * that knows Cloudinary exists — and the only one to change when it stops
 * being the answer.
 */
import { env } from "../config/env.js";
import { CloudinaryStorage } from "./cloudinary.js";
import { MemoryStorage } from "./memory.js";
import type { StorageProvider } from "./StorageProvider.js";

let cached: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  cached ??= env.STORAGE_DRIVER === "memory" ? new MemoryStorage() : new CloudinaryStorage();
  return cached;
}

/** Test seam: drops the cached provider so the next call rebuilds it. */
export function resetStorage(): void {
  cached = undefined;
}

export { CloudinaryStorage } from "./cloudinary.js";
export { MemoryStorage } from "./memory.js";
export type { StorageProvider, StoredImage, UploadOptions } from "./StorageProvider.js";
