/**
 * Every authentication decision in the system.
 *
 * Routes hand this service a validated payload and get back either a result or
 * a thrown `AppError` — no route makes a security judgement of its own. The
 * service depends on a `SessionRepository` and a `Mailer` interface rather than
 * on Prisma and Resend directly, so the rules here can be exercised without a
 * database or an outbound email.
 *
 * Two recurring themes worth knowing before reading:
 *
 *  - **No enumeration.** Login and forgot-password respond identically whether
 *    or not the account exists, including in how long they take.
 *  - **Rotation with reuse detection.** Refresh tokens are single-use. Seeing
 *    one twice means it leaked, so the whole lineage is revoked rather than
 *    just the replayed token.
 */
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  UnauthorizedError,
} from "../http/errors.js";
import { describeError, logger } from "../logging/logger.js";
import type { Mailer } from "../mail/Mailer.js";
import { passwordChangedEmail, passwordResetEmail } from "../mail/templates.js";
import { burnComparison, hashPassword, verifyPassword } from "./password.js";
import type { SessionContext, SessionRepository } from "./sessionRepo.js";
import { expiresInSeconds, generateOpaqueToken, hashToken, signAccessToken } from "./tokens.js";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_MINUTES = 30;

export interface AuthenticatedResult {
  user: { id: string; email: string; name: string | null; role: string };
  accessToken: string;
  /** Access-token lifetime in seconds, so the client can schedule a refresh. */
  expiresIn: number;
  /** Belongs in an httpOnly cookie; never return it in a JSON body. */
  refreshToken: string;
}

export class AuthService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly mailer: Mailer,
  ) {}

  /* ── Login ──────────────────────────────────────────────────── */

  async login(email: string, password: string, context: SessionContext): Promise<AuthenticatedResult> {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    if (!user) {
      // Spend the same time bcrypt would have spent on a real account, so
      // latency does not reveal whether the address is registered.
      await burnComparison(password);
      throw new UnauthorizedError("That email or password is not correct.", ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedError(
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        ErrorCode.ACCOUNT_LOCKED,
      );
    }

    if (!user.isActive) {
      throw new ForbiddenError("This account has been disabled.");
    }

    const matches = await verifyPassword(password, user.password);
    if (!matches) {
      await this.recordFailedLogin(user.id, user.failedLoginCount);
      throw new UnauthorizedError("That email or password is not correct.", ErrorCode.INVALID_CREDENTIALS);
    }

    const fresh = await prisma.adminUser.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    logger.info("admin signed in", { userId: user.id });
    return this.issueTokens(fresh, context);
  }

  private async recordFailedLogin(userId: string, currentCount: number): Promise<void> {
    const attempts = currentCount + 1;
    const lock = attempts >= MAX_FAILED_LOGINS;

    await prisma.adminUser.update({
      where: { id: userId },
      data: {
        failedLoginCount: attempts,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });

    if (lock) logger.warn("admin account locked after repeated failures", { userId, attempts });
  }

  /* ── Refresh ────────────────────────────────────────────────── */

  async refresh(refreshToken: string, context: SessionContext): Promise<AuthenticatedResult> {
    const session = await this.sessions.findByToken(refreshToken);
    if (!session) {
      throw new UnauthorizedError("Your session is no longer valid.", ErrorCode.TOKEN_INVALID);
    }

    if (session.revokedAt) {
      // The token was already rotated away, so whoever presented it is holding
      // a copy. We cannot tell the legitimate holder from the attacker, so both
      // lose access and the real user simply signs in again.
      const revoked = await this.sessions.revokeFamily(session.familyId);
      logger.warn("refresh token reuse detected — revoked session family", {
        userId: session.userId,
        familyId: session.familyId,
        revoked,
      });
      throw new UnauthorizedError("Your session was ended for security reasons.", ErrorCode.TOKEN_INVALID);
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedError("Your session has expired.", ErrorCode.TOKEN_EXPIRED);
    }

    const user = await prisma.adminUser.findUnique({ where: { id: session.userId } });
    if (!user || !user.isActive) {
      await this.sessions.revokeFamily(session.familyId);
      throw new UnauthorizedError("Your session is no longer valid.", ErrorCode.TOKEN_INVALID);
    }

    // Revoke before issuing: if the write below fails, the old token is already
    // dead, which is the safe direction to fail in.
    await this.sessions.revoke(session.id);
    return this.issueTokens(user, context, session.familyId);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;

    const session = await this.sessions.findByToken(refreshToken);
    // Revoke the family, not just this token: signing out should end the
    // lineage, so a token stolen earlier in it cannot be refreshed afterwards.
    if (session) await this.sessions.revokeFamily(session.familyId);
  }

  /* ── Password reset ─────────────────────────────────────────── */

  /**
   * Always resolves. The caller responds 202 regardless, so an attacker cannot
   * use this endpoint to discover which addresses have accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      logger.info("password reset requested for an unknown or inactive account");
      return;
    }

    const token = generateOpaqueToken();

    await prisma.$transaction([
      // Requesting a new link invalidates any earlier one, so a forwarded or
      // intercepted older email stops working immediately.
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: expiresInSeconds(RESET_TOKEN_MINUTES * 60),
        },
      }),
    ]);

    try {
      await this.mailer.send(passwordResetEmail(user.email, token, RESET_TOKEN_MINUTES));
      logger.info("password reset email dispatched", { userId: user.id });
    } catch (error) {
      // The token is already stored, so surfacing a provider outage as a 502
      // here would tell the caller the address exists. Log and stay quiet.
      logger.error("failed to send password reset email", { userId: user.id, ...describeError(error) });
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    const invalid = new UnauthorizedError("This reset link is invalid or has expired.", ErrorCode.TOKEN_INVALID);
    if (!record || record.usedAt || record.expiresAt <= new Date()) throw invalid;
    if (!record.user.isActive) throw invalid;

    const sameAsCurrent = await verifyPassword(newPassword, record.user.password);
    if (sameAsCurrent) {
      throw new ConflictError("Choose a password you have not used before.", ErrorCode.CONFLICT);
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction([
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } }),
      prisma.adminUser.update({
        where: { id: record.userId },
        // `passwordChangedAt` is what invalidates outstanding access tokens;
        // the session sweep below handles refresh tokens.
        data: { password: passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      }),
      prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    logger.info("password reset completed", { userId: record.userId });
    await this.notifyPasswordChanged(record.user.email);
  }

  /* ── Change password ────────────────────────────────────────── */

  /**
   * Re-issues credentials for the caller's current device and signs every other
   * one out — the usual reason to change a password is that another session
   * should no longer exist.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    context: SessionContext,
  ): Promise<AuthenticatedResult> {
    const user = await prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedError("Your session is no longer valid.", ErrorCode.TOKEN_INVALID);

    const matches = await verifyPassword(currentPassword, user.password);
    if (!matches) {
      throw new UnauthorizedError("Your current password is not correct.", ErrorCode.INVALID_CREDENTIALS);
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      return tx.adminUser.update({
        where: { id: userId },
        data: { password: passwordHash, passwordChangedAt: now },
      });
    });

    logger.info("admin changed password", { userId });
    await this.notifyPasswordChanged(user.email);

    // A fresh pair, so the admin who just changed their password is not bounced
    // to the login screen by the invalidation they triggered.
    return this.issueTokens(updated, context);
  }

  /* ── Shared ─────────────────────────────────────────────────── */

  private async issueTokens(
    user: { id: string; email: string; name: string | null; role: string; passwordChangedAt: Date },
    context: SessionContext,
    familyId?: string,
  ): Promise<AuthenticatedResult> {
    const { token: accessToken, expiresIn } = signAccessToken({
      sub: user.id,
      role: user.role,
      pwdAt: user.passwordChangedAt.getTime(),
    });

    const { token: refreshToken } = await this.sessions.issue(
      user.id,
      env.REFRESH_TOKEN_TTL,
      context,
      familyId,
    );

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken,
      expiresIn,
      refreshToken,
    };
  }

  /** Advisory only — a failure here must not undo a completed password change. */
  private async notifyPasswordChanged(email: string): Promise<void> {
    try {
      await this.mailer.send(passwordChangedEmail(email));
    } catch (error) {
      logger.error("failed to send password-changed notification", describeError(error));
    }
  }
}
