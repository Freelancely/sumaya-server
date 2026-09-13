/**
 * The Express application.
 *
 * Built by a function rather than assembled at module scope so a test can hold
 * an app without a listening socket, and so the order of the chain below is
 * stated in one readable place. That order is load-bearing: context and
 * security headers run before anything can fail, the JSON parser runs before
 * routes but never touches a multipart upload, and the error handler is last so
 * it can catch everything in front of it.
 */
import express, { type Express, Router } from "express";
import cookieParser from "cookie-parser";

import { env } from "./config/env.js";
import { attachRequestContext, cors, errorHandler, notFound, securityHeaders } from "./http/middleware.js";
import { authRouter } from "./routes/auth.js";
import { categoriesRouter } from "./routes/categories.js";
import { healthRouter } from "./routes/health.js";
import { imagesRouter } from "./routes/images.js";
import { piecesRouter } from "./routes/pieces.js";

/** Bounds a JSON body. Uploads are multipart and bounded separately, in busboy. */
const JSON_BODY_LIMIT = "256kb";

export function createApp(): Express {
  const app = express();

  // Only when configured: with this off, `req.ip` is the socket address, which
  // is the honest answer for a directly exposed process and the one every rate
  // limit should be counted against.
  app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");
  // A strict router would 404 "/api/pieces/" against "/api/pieces"; the SPA
  // should not have to care which one it built.
  app.set("strict routing", false);

  app.use(attachRequestContext);
  app.use(securityHeaders);
  app.use(cors);

  // Scoped to JSON by type, so a multipart upload reaches its route as an
  // untouched stream for busboy to read.
  app.use(express.json({ limit: JSON_BODY_LIMIT, type: "application/json" }));
  app.use(cookieParser());

  app.use(healthRouter);

  const api = Router();
  api.use("/auth", authRouter);
  api.use("/pieces", piecesRouter);
  api.use("/images", imagesRouter);
  api.use("/categories", categoriesRouter);
  app.use("/api", api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
