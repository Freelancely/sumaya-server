/**
 * Response helpers. Every response the API produces goes through here, so the
 * envelope, the request id header and the cache policy stay consistent.
 */
import type { Response } from "express";

import type { ErrorCodeValue } from "./errors.js";

export interface ErrorBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

function base(res: Response, status: number, requestId: string): Response {
  res.setHeader("x-request-id", requestId);
  return res.status(status);
}

export function json<T>(res: Response, requestId: string, status: number, body: T): void {
  base(res, status, requestId).json(body);
}

export function ok<T>(res: Response, requestId: string, body: T): void {
  json(res, requestId, 200, body);
}

export function created<T>(res: Response, requestId: string, body: T): void {
  json(res, requestId, 201, body);
}

export function accepted<T>(res: Response, requestId: string, body: T): void {
  json(res, requestId, 202, body);
}

export function noContent(res: Response, requestId: string): void {
  base(res, 204, requestId).end();
}

export function fail(
  res: Response,
  requestId: string,
  status: number,
  body: ErrorBody,
  headers?: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(headers ?? {})) res.setHeader(key, value);
  json(res, requestId, status, body);
}

/**
 * Public catalogue reads are safe to cache in front of the server.
 * `stale-while-revalidate` keeps the site fast right after an admin edit
 * without serving stale data for long — the cache revalidates in the
 * background.
 */
export function publicCache(res: Response, seconds = 60): void {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
}

/** Anything authenticated or personalised must never be stored by a shared cache. */
export function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
}
