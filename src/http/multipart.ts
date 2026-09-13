/**
 * Multipart form parsing for image uploads.
 *
 * The JSON body parser is mounted for JSON content types only, so a multipart
 * request arrives here as an untouched stream and goes straight to busboy.
 *
 * Limits are enforced by busboy itself rather than checked after the fact:
 * buffering an unbounded upload into memory first and *then* rejecting it is
 * how a process runs out of heap.
 */
import type { Request } from "express";
import busboy from "busboy";

import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "./errors.js";

export interface ParsedFile {
  fieldName: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: ParsedFile[];
}

export interface MultipartLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxFields: number;
}

export const DEFAULT_LIMITS: MultipartLimits = {
  // Comfortably above a 1600px export of a piece, and small enough that a
  // handful of concurrent uploads cannot exhaust the process's heap.
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 1,
  maxFields: 10,
};

/**
 * Buffers the request body.
 *
 * This MUST be called synchronously, before the handler awaits anything: the
 * request is a live stream, and an `await` on the database between the request
 * arriving and the listeners attaching is long enough for it to reach `end`
 * unobserved. busboy then sees a body that is over before it began and reports
 * "Unexpected end of form", which surfaces as a 500 on a perfectly good upload.
 *
 * The route wrapper starts this for any route declaring `rawBody`, so auth,
 * rate limiting and validation can still run first without losing the payload.
 */
export function collectRawBody(req: Request, limit = DEFAULT_LIMITS.maxFileBytes + 512 * 1024): Promise<Buffer> {
  // A parser earlier in the chain may have read and replayed the body already.
  const existing = (req as Request & { body?: unknown }).body;
  if (Buffer.isBuffer(existing)) return Promise.resolve(existing);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Stop before the heap does; the per-file limit is enforced again below.
      if (size > limit) {
        req.pause();
        reject(new PayloadTooLargeError("That upload is larger than this endpoint accepts."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

export async function parseMultipart(
  req: Request,
  raw: Buffer | Promise<Buffer>,
  limits: MultipartLimits = DEFAULT_LIMITS,
): Promise<ParsedMultipart> {
  const contentType = req.headers["content-type"];
  if (!contentType?.includes("multipart/form-data")) {
    throw new ValidationError("Send the image as multipart/form-data.");
  }

  const buffered = await raw;

  return new Promise<ParsedMultipart>((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: limits.maxFileBytes,
        files: limits.maxFiles,
        fields: limits.maxFields,
        fieldSize: 4096,
      },
    });

    const fields: Record<string, string> = {};
    const files: ParsedFile[] = [];
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ fields, files });
    };

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (fieldName, stream, info) => {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      stream.on("limit", () => {
        const mb = (limits.maxFileBytes / (1024 * 1024)).toFixed(1);
        finish(new PayloadTooLargeError(`Images must be ${mb}MB or smaller.`));
      });

      stream.on("end", () => {
        if (settled) return;
        files.push({
          fieldName,
          filename: info.filename ?? "upload",
          mimeType: info.mimeType,
          data: Buffer.concat(chunks),
        });
      });
    });

    bb.on("filesLimit", () => finish(new ValidationError("Upload one image at a time.")));
    bb.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    bb.on("close", () => finish());

    // Fed from the buffer, not from `req` — by now the stream is long finished.
    bb.end(buffered);
  });
}

/**
 * Identifies a file by its leading bytes rather than by the `Content-Type` the
 * client claimed. A declared mime type is caller-controlled, so trusting it is
 * what lets someone upload a script with an image label on it.
 */
export function sniffImageType(data: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (data.length < 12) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";

  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  // RIFF container with a WEBP fourcc at offset 8.
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  return null;
}

export function assertSupportedImage(file: ParsedFile): string {
  const detected = sniffImageType(file.data);
  if (!detected) {
    throw new UnsupportedMediaTypeError("Upload a JPEG, PNG or WebP image.");
  }
  return detected;
}
