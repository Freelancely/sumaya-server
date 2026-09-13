/**
 * App-level middleware: the concerns that must cover *every* response,
 * including the ones no route ever sees — a 404, a body the JSON parser
 * rejected, a 405.
 */
import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

import { env } from "../config/env.js";
import { describeError, logger as rootLogger, type Logger } from "../logging/logger.js";
import { clientIp } from "./context.js";
import { toErrorResponse } from "./errorMapping.js";
import { ErrorCode } from "./errors.js";
import { fail } from "./respond.js";

/** What `attachRequestContext` hangs off the request object. */
interface RequestLocals {
  requestId: string;
  logger: Logger;
}

const LOCALS = Symbol("sumaya.request");

type WithLocals = Request & { [LOCALS]?: RequestLocals };

export function requestId(req: Request): string {
  return (req as WithLocals)[LOCALS]?.requestId ?? "unknown";
}

export function requestLogger(req: Request): Logger {
  return (req as WithLocals)[LOCALS]?.logger ?? rootLogger;
}

/**
 * Stamps every request with an id and a logger bound to it.
 *
 * An inbound `x-request-id` is honoured so a trace started by a proxy or by the
 * SPA carries through; otherwise one is minted. It goes back on the response
 * either way, which is the only handle a user has on a 500.
 */
export const attachRequestContext: RequestHandler = (req, res, next) => {
  const header = req.headers["x-request-id"];
  const id = (Array.isArray(header) ? header[0] : header)?.slice(0, 200) || randomUUID();

  (req as WithLocals)[LOCALS] = {
    requestId: id,
    logger: rootLogger.child({ requestId: id, method: req.method, path: req.path, ip: clientIp(req) }),
  };

  res.setHeader("x-request-id", id);
  next();
};

/** Applied to every response, successful or not. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Express advertises itself by default; there is no reason to tell a scanner
  // what to look up.
  res.removeHeader("X-Powered-By");
  if (env.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
};

/**
 * Reflects the origin only when it is on the allowlist. Echoing back whatever
 * arrives would defeat the point of `Allow-Credentials`, which the refresh
 * cookie depends on.
 */
export const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && env.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-request-id");
  res.setHeader("Access-Control-Max-Age", "86400");
  next();
};

/** Unmatched paths get the same envelope as everything else, not Express's HTML. */
export const notFound: RequestHandler = (req, res) => {
  const id = requestId(req);
  requestLogger(req).warn("no route matched", { status: 404 });
  fail(res, id, 404, {
    error: { code: ErrorCode.NOT_FOUND, message: "That endpoint does not exist.", requestId: id },
  });
};

/**
 * The last line of defence. Route handlers map their own failures, so anything
 * arriving here was thrown by middleware — or by a handler that had already
 * started writing, in which case the only honest thing left is to drop the
 * connection rather than append a second, contradictory body.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const id = requestId(req);
  const { status, body, headers, internal } = toErrorResponse(error, id);

  if (internal) requestLogger(req).error("request failed", { status, ...describeError(error) });
  else requestLogger(req).warn("request rejected", { status, code: body.error.code });

  if (res.headersSent) {
    next(error);
    return;
  }
  fail(res, id, status, body, headers);
};
