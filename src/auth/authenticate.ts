/**
 * Turns a bearer token into a user, or refuses.
 *
 * Verifying the signature is not enough on its own: the account may have been
 * disabled, deleted, or had its password changed since the token was minted.
 * Those are exactly the cases where a stateless token would otherwise stay
 * valid for its full lifetime, so one indexed lookup per request buys real
 * revocation.
 */
import type { Request } from "express";

import type { AuthenticatedUser } from "../http/context.js";
import { ErrorCode, UnauthorizedError } from "../http/errors.js";
import { prisma } from "../db/prisma.js";
import { verifyAccessToken } from "./tokens.js";

export function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim() || undefined;
}

export async function authenticateRequest(req: Request): Promise<AuthenticatedUser> {
  const token = readBearerToken(req);
  if (!token) throw new UnauthorizedError("Sign in to continue.");

  const claims = verifyAccessToken(token);

  const user = await prisma.adminUser.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, name: true, role: true, isActive: true, passwordChangedAt: true },
  });

  if (!user) throw new UnauthorizedError("Your session is no longer valid.", ErrorCode.TOKEN_INVALID);
  if (!user.isActive) throw new UnauthorizedError("This account has been disabled.", ErrorCode.ACCOUNT_DISABLED);

  // Second granularity: JWT `iat`/our `pwdAt` are compared loosely enough to
  // tolerate the truncation JWT timestamps apply, strictly enough that a
  // password change invalidates tokens minted before it.
  if (Math.floor(user.passwordChangedAt.getTime() / 1000) > Math.floor(claims.pwdAt / 1000)) {
    throw new UnauthorizedError("Your password changed. Please sign in again.", ErrorCode.TOKEN_INVALID);
  }

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
