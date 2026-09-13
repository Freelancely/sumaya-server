/**
 * Persistence for refresh-token sessions.
 *
 * The service above talks in terms of "issue a session", "rotate this one",
 * "revoke this family" — it never writes a Prisma query itself. That keeps the
 * storage choice swappable and the service testable against a fake.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "../db/prisma.js";
import { expiresInSeconds, generateOpaqueToken, hashToken } from "./tokens.js";

export interface SessionRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface IssuedSession {
  /** The raw token. Returned once, here, and never stored or logged. */
  token: string;
  record: SessionRecord;
}

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

export interface SessionRepository {
  issue(userId: string, ttlSeconds: number, context: SessionContext, familyId?: string): Promise<IssuedSession>;
  findByToken(token: string): Promise<SessionRecord | null>;
  revoke(sessionId: string): Promise<void>;
  revokeFamily(familyId: string): Promise<number>;
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number>;
  pruneExpired(): Promise<number>;
}

export class PrismaSessionRepository implements SessionRepository {
  /**
   * A rotation passes the previous `familyId` through, so an entire lineage
   * stays linked back to the original login and can be revoked as one unit.
   */
  async issue(
    userId: string,
    ttlSeconds: number,
    context: SessionContext,
    familyId = randomUUID(),
  ): Promise<IssuedSession> {
    const token = generateOpaqueToken();

    const record = await prisma.session.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt: expiresInSeconds(ttlSeconds),
        // Truncated: these are diagnostic breadcrumbs, not a reason to store an
        // unbounded header from an untrusted client.
        userAgent: context.userAgent?.slice(0, 300),
        ip: context.ip?.slice(0, 64),
      },
      select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true },
    });

    return { token, record };
  }

  /**
   * Looks up by hash, which is an indexed unique column — so this is a point
   * read, and the raw token never needs to be compared against anything.
   */
  async findByToken(token: string): Promise<SessionRecord | null> {
    return prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true },
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<number> {
    const { count } = await prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const { count } = await prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /** Housekeeping. Expiry is enforced on read, so this is purely to keep the table small. */
  async pruneExpired(): Promise<number> {
    const { count } = await prisma.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return count;
  }
}
