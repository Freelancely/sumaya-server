/**
 * `route` — the one place transport concerns are handled.
 *
 * A route declares *what* it accepts (method, auth, schemas, limits) and
 * receives a validated context. Everything cross-cutting — authentication,
 * rate limiting, validation, and the mapping from a thrown error to a status
 * code — happens here exactly once. A route that forgets to check auth is not
 * possible, because checking auth is not the route's job. (CORS, security
 * headers and request ids are earlier still, in `middleware.ts`, so they also
 * cover 404s and anything a body parser rejects.)
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { ZodTypeAny, z } from "zod";

import { authenticateRequest } from "../auth/authenticate.js";
import { describeError } from "../logging/logger.js";
import { requestLogger, requestId as requestIdOf } from "./middleware.js";
import { clientIp, type AuthenticatedContext, type RequestContext } from "./context.js";
import { AppError, ErrorCode, MethodNotAllowedError, ValidationError } from "./errors.js";
import { toErrorResponse } from "./errorMapping.js";
import { collectRawBody } from "./multipart.js";
import { enforceRateLimit, type RateLimitRule } from "./rateLimit.js";
import { fail, noStore } from "./respond.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Chooses what a rate-limit window is counted against for this request. */
export type RateLimitSelector = (req: Request, ip: string) => string;

export interface RateLimitSpec {
  rule: RateLimitRule;
  /** Defaults to the client IP. */
  by?: RateLimitSelector;
}

export interface RouteDefinition<TBodySchema extends ZodTypeAny, TQuerySchema extends ZodTypeAny> {
  /** `"required"` rejects anonymous callers; `"optional"` resolves a user when a token is present. */
  auth?: "required" | "optional" | "none";
  /** Additionally restricts an authenticated route to these roles. */
  roles?: string[];
  body?: TBodySchema;
  /** Validates path parameters and the query string together. */
  query?: TQuerySchema;
  rateLimits?: RateLimitSpec[];
  /**
   * Skips body validation, leaving the raw stream alone. Multipart uploads need
   * this — they are consumed by busboy, not by a JSON schema.
   */
  rawBody?: boolean;
  handler: (ctx: RequestContext<z.infer<TBodySchema>, z.infer<TQuerySchema>>) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDefinition<any, any>;

/**
 * A body the JSON parser has not seen (a multipart or empty request) arrives as
 * `undefined` or a Buffer. Normalise that before a schema ever looks at it.
 */
function readJsonBody(req: Request): unknown {
  const { body } = req;
  if (body === undefined || body === null || body === "") return {};

  if (Buffer.isBuffer(body)) {
    const text = body.toString("utf8").trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError("The request body is not valid JSON.");
    }
  }

  return body;
}

/**
 * Path parameters and query string in one object, so a schema can validate
 * `/pieces/:id?purge=true` as a single shape. The path wins on a collision: it
 * is the part of the request the router itself matched.
 */
function readQuery(req: Request): unknown {
  return { ...(req.query as Record<string, unknown>), ...req.params };
}

function parse<TSchema extends ZodTypeAny>(schema: TSchema | undefined, value: unknown): unknown {
  return schema ? schema.parse(value) : value;
}

/** Wraps one route definition as an Express handler. */
export function route<TBodySchema extends ZodTypeAny, TQuerySchema extends ZodTypeAny>(
  definition: RouteDefinition<TBodySchema, TQuerySchema>,
): RequestHandler {
  return async function handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestId = requestIdOf(req);
    const log = requestLogger(req);
    const ip = clientIp(req);
    const startedAt = Date.now();

    /**
     * Started here, synchronously, and deliberately before the first `await`
     * below: the request body is a live stream that ends on its own schedule,
     * and a rate-limit or auth round trip is long enough to miss it entirely.
     * Nothing awaits this until the handler asks for it.
     */
    const rawBody = definition.rawBody ? collectRawBody(req) : undefined;
    // Nothing may reject unobserved while auth runs first.
    rawBody?.catch(() => undefined);

    try {
      for (const spec of definition.rateLimits ?? []) {
        await enforceRateLimit(spec.rule, spec.by ? spec.by(req, ip) : ip);
      }

      let user = null;
      if (definition.auth === "required") {
        user = await authenticateRequest(req);
        if (definition.roles && !definition.roles.includes(user.role)) {
          throw new AppError(403, ErrorCode.FORBIDDEN, "You do not have access to this resource.");
        }
      } else if (definition.auth === "optional") {
        // A malformed token on an optional route is simply anonymous, not an error.
        user = await authenticateRequest(req).catch(() => null);
      }

      if (user) noStore(res);

      const body = definition.rawBody ? undefined : parse(definition.body, readJsonBody(req));
      const query = parse(definition.query, readQuery(req));

      await definition.handler({ req, res, requestId, logger: log, ip, user, body, query, rawBody });

      log.info("request completed", { status: res.statusCode, durationMs: Date.now() - startedAt });
    } catch (error) {
      const { status, body, headers, internal } = toErrorResponse(error, requestId);

      if (internal) {
        log.error("request failed", { status, durationMs: Date.now() - startedAt, ...describeError(error) });
      } else {
        log.warn("request rejected", { status, code: body.error.code, durationMs: Date.now() - startedAt });
      }

      // A handler that already started writing cannot be given a clean error
      // response; hand it to Express, which will abort the connection.
      if (res.headersSent) {
        next(error);
        return;
      }
      fail(res, requestId, status, body, headers);
    }
  };
}

const EXPRESS_METHOD: Record<Method, "get" | "post" | "patch" | "put" | "delete"> = {
  GET: "get",
  POST: "post",
  PATCH: "patch",
  PUT: "put",
  DELETE: "delete",
};

/**
 * Registers a path's methods and, for the same path, the 405 that answers every
 * other one.
 *
 * Grouping a path's methods in a single call is what makes `Allow` accurate
 * without restating it: the wrapper knows exactly which verbs were declared.
 */
export function mount(router: Router, path: string, routes: Partial<Record<Method, AnyRoute>>): void {
  const allowed = Object.keys(routes) as Method[];

  for (const method of allowed) {
    router[EXPRESS_METHOD[method]](path, route(routes[method]!));
  }

  router.options(path, (_req, res) => {
    res.setHeader("Allow", [...allowed, "OPTIONS"].join(", "));
    res.status(204).end();
  });

  // Reached only for verbs not registered above, since Express tries the
  // specific handlers first.
  router.all(path, (_req, _res, next) => next(new MethodNotAllowedError(allowed)));
}

export type { AuthenticatedContext, RequestContext };
