/**
 * Per-request context passed to every handler.
 *
 * Handlers receive parsed, validated data and an already-resolved user — they
 * never touch `req` for anything the middleware has already established. That
 * is what keeps route definitions down to a few lines of intent.
 */
import type { Request, Response } from "express";

import type { Logger } from "../logging/logger.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface RequestContext<TBody = unknown, TQuery = unknown> {
  req: Request;
  res: Response;
  requestId: string;
  logger: Logger;
  /** Best-effort client IP, for rate limiting and audit lines. */
  ip: string;
  /** Present whenever the route declared `auth: "required"`. */
  user: AuthenticatedUser | null;
  body: TBody;
  /** Path parameters and the query string, merged — path wins on a clash. */
  query: TQuery;
  /**
   * The buffered request body, for routes declaring `rawBody`. Started before
   * any await so the stream is never missed; awaited by the handler when it is
   * ready to parse.
   */
  rawBody?: Promise<Buffer>;
}

/**
 * Narrows a context whose route required authentication. The route wrapper
 * guarantees a user is present in that case, but the type system needs telling.
 */
export interface AuthenticatedContext<TBody = unknown, TQuery = unknown>
  extends RequestContext<TBody, TQuery> {
  user: AuthenticatedUser;
}

/**
 * The client address.
 *
 * `req.ip` already honours Express's `trust proxy` setting, which `app.ts` only
 * enables when `TRUST_PROXY` is set. That distinction is load-bearing: behind a
 * proxy the socket address is the proxy's and `x-forwarded-for` is the truth,
 * but exposed directly the same header is attacker-controlled — and it is what
 * every rate limit is counted against.
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
