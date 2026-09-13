/**
 * `/api/auth` — sessions and password management.
 *
 * Every route here is transport only: it names its schema, its limits and the
 * service call, and makes no security judgement of its own. Those all live in
 * `AuthService`.
 */
import { Router } from "express";

import { getAuthService } from "../auth/index.js";
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from "../http/cookies.js";
import { ErrorCode, UnauthorizedError } from "../http/errors.js";
import { RateLimits } from "../http/rateLimit.js";
import { accepted, noStore, ok } from "../http/respond.js";
import { mount } from "../http/route.js";
import { changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema } from "../validation/schemas.js";

export const authRouter: Router = Router();

/**
 * POST /api/auth/login
 *
 * Returns the access token in the body (the SPA holds it in memory) and the
 * refresh token in an httpOnly cookie, which JavaScript cannot read.
 */
mount(authRouter, "/login", {
  POST: {
    body: loginSchema,
    rateLimits: [
      // Counted per IP *and* address, so a botnet spraying one account and a
      // single host spraying many are both throttled.
      { rule: RateLimits.login },
      {
        rule: RateLimits.login,
        by: (req, ip) => `${ip}:${String((req.body as { email?: string })?.email ?? "").toLowerCase()}`,
      },
    ],
    async handler({ req, res, requestId, body, ip }) {
      const result = await getAuthService().login(body.email, body.password, {
        ip,
        userAgent: req.headers["user-agent"],
      });

      noStore(res);
      setRefreshCookie(res, result.refreshToken);

      ok(res, requestId, {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    },
  },
});

/**
 * POST /api/auth/refresh
 *
 * Exchanges the refresh cookie for a new access token and a new refresh token.
 * The old refresh token dies in the process; presenting it again is treated as
 * theft (see `AuthService.refresh`).
 */
mount(authRouter, "/refresh", {
  POST: {
    rateLimits: [{ rule: RateLimits.refresh }],
    async handler({ req, res, requestId, ip }) {
      const token = readRefreshToken(req);
      if (!token) throw new UnauthorizedError("No active session.", ErrorCode.TOKEN_INVALID);

      const result = await getAuthService().refresh(token, {
        ip,
        userAgent: req.headers["user-agent"],
      });

      noStore(res);
      setRefreshCookie(res, result.refreshToken);

      ok(res, requestId, {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    },
  },
});

/**
 * POST /api/auth/logout
 *
 * Unauthenticated by design: an expired access token must not stop someone
 * signing out. The refresh cookie is the only credential that matters here.
 */
mount(authRouter, "/logout", {
  POST: {
    async handler({ req, res, requestId }) {
      await getAuthService().logout(readRefreshToken(req));

      noStore(res);
      clearRefreshCookie(res);
      // Always 200, whether or not there was a session to end — the client's
      // job is simply to discard its state.
      ok(res, requestId, { signedOut: true });
    },
  },
});

/**
 * GET /api/auth/me
 *
 * Used on app boot to decide whether the admin UI can render.
 * `authenticateRequest` has already re-read the account, so a disabled or
 * password-changed user is rejected here even with a technically valid token.
 */
mount(authRouter, "/me", {
  GET: {
    auth: "required",
    async handler({ res, requestId, user }) {
      ok(res, requestId, { user });
    },
  },
});

/**
 * POST /api/auth/forgot-password
 *
 * Always 202, always the same body, always roughly the same latency — whether
 * or not the address has an account. Anything else turns this endpoint into an
 * account-enumeration oracle.
 */
mount(authRouter, "/forgot-password", {
  POST: {
    body: forgotPasswordSchema,
    rateLimits: [
      { rule: RateLimits.forgotPasswordByIp },
      // Per-address as well, so one account cannot be mail-bombed from many IPs.
      {
        rule: RateLimits.forgotPasswordByEmail,
        by: (req) => String((req.body as { email?: string })?.email ?? "").toLowerCase(),
      },
    ],
    async handler({ res, requestId, body }) {
      await getAuthService().requestPasswordReset(body.email);

      noStore(res);
      accepted(res, requestId, {
        message: "If an account exists for that address, a reset link is on its way.",
      });
    },
  },
});

/**
 * POST /api/auth/reset-password
 *
 * Consumes a single-use token from the reset email. On success every session is
 * revoked, so the admin signs in again with the new password — including on the
 * device that requested the reset.
 */
mount(authRouter, "/reset-password", {
  POST: {
    body: resetPasswordSchema,
    rateLimits: [{ rule: RateLimits.resetPassword }],
    async handler({ res, requestId, body }) {
      await getAuthService().resetPassword(body.token, body.password);

      noStore(res);
      clearRefreshCookie(res);
      ok(res, requestId, { message: "Your password has been reset. Please sign in." });
    },
  },
});

/**
 * POST /api/auth/change-password
 *
 * Requires the current password even though the caller is already
 * authenticated: it is what stops a stolen access token from locking the real
 * owner out of their own account.
 */
mount(authRouter, "/change-password", {
  POST: {
    auth: "required",
    body: changePasswordSchema,
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ req, res, requestId, body, user, ip }) {
      const result = await getAuthService().changePassword(
        user!.id,
        body.currentPassword,
        body.newPassword,
        { ip, userAgent: req.headers["user-agent"] },
      );

      noStore(res);
      // Other devices were just signed out; this one gets replacement credentials.
      setRefreshCookie(res, result.refreshToken);

      ok(res, requestId, {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        message: "Password updated. Other devices have been signed out.",
      });
    },
  },
});
