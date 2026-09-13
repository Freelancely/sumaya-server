/**
 * Refresh-token cookie handling.
 *
 * The refresh token lives in an httpOnly cookie rather than in JS-readable
 * storage, so XSS on the admin UI cannot exfiltrate a long-lived credential.
 * `SameSite=Strict` plus a `Path` limited to the auth routes means it is only
 * ever attached to the handful of requests that need it, which removes CSRF as
 * a concern for every other endpoint.
 *
 * `Set-Cookie` is appended rather than assigned: a response may already be
 * carrying one, and overwriting the header would silently drop it.
 */
import type { Request, Response } from "express";

import { env } from "../config/env.js";

export const REFRESH_COOKIE = "sumaya_rt";
const COOKIE_PATH = "/api/auth";

function serialise(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${REFRESH_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  // Browsers reject `Secure` cookies over plain http, which would break local dev.
  if (env.isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function setRefreshCookie(res: Response, token: string): void {
  res.append("Set-Cookie", serialise(token, env.REFRESH_TOKEN_TTL));
}

export function clearRefreshCookie(res: Response): void {
  res.append("Set-Cookie", serialise("", 0));
}

/**
 * Reads the refresh token. The cookie is authoritative; the JSON body is only
 * consulted as a fallback for non-browser clients that cannot hold cookies.
 */
export function readRefreshToken(req: Request): string | undefined {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (fromCookie) return fromCookie;

  const body = req.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === "string" ? body.refreshToken : undefined;
}
