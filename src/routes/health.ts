/**
 * Liveness and readiness.
 *
 * A long-running process needs both, and they answer different questions:
 * `/health` says the event loop is turning (restart me if this fails), while
 * `/ready` says the database answers (stop sending me traffic if this fails).
 * Conflating them is how an orchestrator ends up killing a healthy process
 * during a brief database blip.
 */
import { Router } from "express";

import { prisma } from "../db/prisma.js";
import { requestLogger } from "../http/middleware.js";
import { describeError } from "../logging/logger.js";

export const healthRouter: Router = Router();

const startedAt = Date.now();

healthRouter.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
});

healthRouter.get("/ready", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ready" });
  } catch (error) {
    requestLogger(req).error("readiness check failed", describeError(error));
    res.status(503).json({ status: "unavailable" });
  }
});
