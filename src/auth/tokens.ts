/**
 * Token minting and verification.
 *
 * Two very different credentials live here:
 *
 *  - the *access token* is a short-lived signed JWT, verified statelessly on
 *    every request, carrying just enough to authorise without a DB round trip;
 *  - the *refresh token* is a long opaque random string with no structure at
 *    all. Only its sha256 is stored, so a database leak yields nothing usable.
 *
 * Stateless access tokens can't be revoked, which is why they last 15 minutes
 * and carry `pwdAt`: a password change bumps `passwordChangedAt` and every
 * token minted before it stops verifying.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ErrorCode, UnauthorizedError } from "../http/errors.js";

const ISSUER = "sumaya-atelier";
const AUDIENCE = "sumaya-admin";

export interface AccessTokenClaims {
  /** AdminUser id. */
  sub: string;
  role: string;
  /** `passwordChangedAt` as epoch milliseconds. */
  pwdAt: number;
  /** Unique token id, for correlating a token with its log lines. */
  jti: string;
}

export function signAccessToken(claims: Omit<AccessTokenClaims, "jti">): { token: string; expiresIn: number } {
  const token = jwt.sign({ ...claims, jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { token, expiresIn: env.ACCESS_TOKEN_TTL };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    // Pinning `algorithms` is what stops an attacker swapping HS256 for "none"
    // or for RS256 with a key of their choosing.
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (typeof payload === "string") throw new Error("Unexpected token payload.");
    const { sub, role, pwdAt, jti } = payload as jwt.JwtPayload & Partial<AccessTokenClaims>;
    if (!sub || !role || typeof pwdAt !== "number" || !jti) {
      throw new Error("Token is missing required claims.");
    }
    return { sub, role, pwdAt, jti };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError("Your session has expired.", ErrorCode.TOKEN_EXPIRED);
    }
    throw new UnauthorizedError("Your session is not valid.", ErrorCode.TOKEN_INVALID);
  }
}

/* ── Opaque tokens (refresh, password reset) ──────────────────── */

/** 32 bytes of CSPRNG output, base64url — ~256 bits, not guessable. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 is right here: the input is already high-entropy, so a slow KDF buys nothing. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, so a lookup can't be narrowed byte by byte. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function expiresInSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
