/**
 * Authentication, end to end through the HTTP surface.
 *
 * The security properties this API claims — no enumeration, lockout, refresh
 * rotation with reuse detection, revocation on password change — are behaviour,
 * not implementation, so they are asserted here against real requests rather
 * than by reaching into the service.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db/prisma.js";
import { REFRESH_COOKIE } from "../src/http/cookies.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  app,
  client,
  createAdmin,
  mailbox,
  request,
  resetDatabase,
  signIn,
} from "./helpers.js";

/** Pulls the refresh cookie's value out of a `Set-Cookie` header. */
function refreshCookieValue(headers: Record<string, unknown>): string | undefined {
  const raw = headers["set-cookie"] as string[] | undefined;
  const cookie = raw?.find((entry) => entry.startsWith(`${REFRESH_COOKIE}=`));
  return cookie?.split(";")[0]?.split("=")[1];
}

beforeEach(async () => {
  await resetDatabase();
});

describe("POST /api/auth/login", () => {
  it("returns an access token in the body and a refresh token in an httpOnly cookie", async () => {
    await createAdmin();

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    expect(response.body.user.email).toBe(ADMIN_EMAIL);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.expiresIn).toBe(900);
    // The long-lived credential must never be readable by JavaScript.
    expect(response.body.refreshToken).toBeUndefined();

    const cookie = (response.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/auth");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("normalises the address, so casing and stray whitespace still sign in", async () => {
    await createAdmin();

    await request(app)
      .post("/api/auth/login")
      .send({ email: `  ${ADMIN_EMAIL.toUpperCase()}  `, password: ADMIN_PASSWORD })
      .expect(200);
  });

  it("answers identically for a wrong password and an address with no account", async () => {
    await createAdmin();

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: "Wrong-Password-1" })
      .expect(401);

    const noSuchAccount = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "Wrong-Password-1" })
      .expect(401);

    // Identical code and message: anything else is an enumeration oracle.
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(noSuchAccount.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(noSuchAccount.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("locks the account after five consecutive failures", async () => {
    await createAdmin();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post("/api/auth/login")
        .send({ email: ADMIN_EMAIL, password: "Wrong-Password-1" })
        .expect(401);
    }

    const locked = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(401);

    // The correct password now fails too — that is the point of a lockout.
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("clears the failure count on a successful sign-in", async () => {
    await createAdmin();

    await request(app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: "Wrong-Password-1" }).expect(401);
    await request(app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).expect(200);

    const user = await prisma.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lastLoginAt).toBeInstanceOf(Date);
  });

  it("refuses a disabled account", async () => {
    await createAdmin({ isActive: false });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a malformed payload with field-level detail", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email", password: "" })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "email" })]),
    );
  });
});

describe("GET /api/auth/me", () => {
  it("returns the account for a valid bearer token", async () => {
    const session = await signIn();

    const response = await request(app).get("/api/auth/me").set(session.auth).expect(200);
    expect(response.body.user.email).toBe(ADMIN_EMAIL);
  });

  it("rejects a missing, malformed or forged token", async () => {
    await signIn();

    await request(app).get("/api/auth/me").expect(401);
    await request(app).get("/api/auth/me").set("Authorization", "Bearer nonsense").expect(401);
    await request(app).get("/api/auth/me").set("Authorization", "Basic abc").expect(401);
  });

  it("rejects a token whose account has since been disabled", async () => {
    const session = await signIn();
    await prisma.adminUser.update({ where: { email: ADMIN_EMAIL }, data: { isActive: false } });

    const response = await request(app).get("/api/auth/me").set(session.auth).expect(401);
    expect(response.body.error.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("POST /api/auth/refresh", () => {
  it("exchanges the cookie for a new pair", async () => {
    const session = await signIn();

    const response = await session.agent.post("/api/auth/refresh").expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toBe(ADMIN_EMAIL);
  });

  it("revokes the whole family when a rotated token is presented again", async () => {
    const agent = client();
    await createAdmin();

    const login = await agent.post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).expect(200);
    const stolen = refreshCookieValue(login.headers as Record<string, unknown>)!;

    // The legitimate holder rotates, which retires `stolen`.
    await agent.post("/api/auth/refresh").expect(200);

    const replay = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${stolen}`)
      .expect(401);

    expect(replay.body.error.code).toBe("TOKEN_INVALID");

    // Both the replayed token and the current one are dead: we cannot tell the
    // thief from the owner, so the lineage ends and the owner signs in again.
    await agent.post("/api/auth/refresh").expect(401);

    const sessions = await prisma.session.findMany();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("refuses when no cookie is present", async () => {
    const response = await request(app).post("/api/auth/refresh").expect(401);
    expect(response.body.error.code).toBe("TOKEN_INVALID");
  });

  it("refuses an expired session", async () => {
    const session = await signIn();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await session.agent.post("/api/auth/refresh").expect(401);
    expect(response.body.error.code).toBe("TOKEN_EXPIRED");
  });
});

describe("POST /api/auth/logout", () => {
  it("ends the lineage and clears the cookie", async () => {
    const session = await signIn();

    const response = await session.agent.post("/api/auth/logout").expect(200);
    expect(response.body.signedOut).toBe(true);
    expect((response.headers["set-cookie"] as unknown as string[])[0]).toContain("Max-Age=0");

    await session.agent.post("/api/auth/refresh").expect(401);
  });

  it("succeeds even with no session to end", async () => {
    await request(app).post("/api/auth/logout").expect(200);
  });
});

describe("password reset", () => {
  it("answers 202 with the same body whether or not the address exists", async () => {
    await createAdmin();

    const known = await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);
    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@example.com" })
      .expect(202);

    expect(unknown.body).toEqual(known.body);
    // One email, for the account that exists.
    expect(mailbox().outbox).toHaveLength(1);
  });

  it("resets the password, revokes every session, and invalidates issued access tokens", async () => {
    const session = await signIn();
    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);

    const link = mailbox().lastTo(ADMIN_EMAIL)!.text.match(/token=([^\s]+)/);
    const token = decodeURIComponent(link![1]);

    await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "Brand-New-Pass-2" })
      .expect(200);

    // The access token minted before the reset no longer verifies…
    await request(app).get("/api/auth/me").set(session.auth).expect(401);
    // …and neither does the refresh cookie.
    await session.agent.post("/api/auth/refresh").expect(401);

    await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: "Brand-New-Pass-2" })
      .expect(200);
  });

  it("refuses a token that has already been used", async () => {
    await createAdmin();
    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);
    const token = decodeURIComponent(mailbox().lastTo(ADMIN_EMAIL)!.text.match(/token=([^\s]+)/)![1]);

    await request(app).post("/api/auth/reset-password").send({ token, password: "Brand-New-Pass-2" }).expect(200);

    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "Another-Pass-33" })
      .expect(401);
    expect(replay.body.error.code).toBe("TOKEN_INVALID");
  });

  it("refuses an expired token", async () => {
    await createAdmin();
    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);
    const token = decodeURIComponent(mailbox().lastTo(ADMIN_EMAIL)!.text.match(/token=([^\s]+)/)![1]);

    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await request(app).post("/api/auth/reset-password").send({ token, password: "Brand-New-Pass-2" }).expect(401);
  });

  it("invalidates an earlier link when a new one is requested", async () => {
    await createAdmin();
    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);
    const first = decodeURIComponent(mailbox().lastTo(ADMIN_EMAIL)!.text.match(/token=([^\s]+)/)![1]);

    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);

    await request(app).post("/api/auth/reset-password").send({ token: first, password: "Brand-New-Pass-2" }).expect(401);
  });

  it("refuses a new password that does not meet the policy", async () => {
    await createAdmin();
    await request(app).post("/api/auth/forgot-password").send({ email: ADMIN_EMAIL }).expect(202);
    const token = decodeURIComponent(mailbox().lastTo(ADMIN_EMAIL)!.text.match(/token=([^\s]+)/)![1]);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "short" })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("POST /api/auth/change-password", () => {
  it("requires the current password", async () => {
    const session = await signIn();

    const response = await request(app)
      .post("/api/auth/change-password")
      .set(session.auth)
      .send({ currentPassword: "Not-The-Password-1", newPassword: "Brand-New-Pass-2" })
      .expect(401);

    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("signs other devices out and re-credentials this one", async () => {
    const first = await signIn();
    // A second device, signed in before the change.
    const second = await signIn();

    const response = await request(app)
      .post("/api/auth/change-password")
      .set(second.auth)
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: "Brand-New-Pass-2" })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));

    // The other device is out, by both credentials it holds.
    await request(app).get("/api/auth/me").set(first.auth).expect(401);
    await first.agent.post("/api/auth/refresh").expect(401);

    // The replacement token from the response works.
    await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${response.body.accessToken}`)
      .expect(200);
  });

  it("rejects reusing the current password as the new one", async () => {
    const session = await signIn();

    const response = await request(app)
      .post("/api/auth/change-password")
      .set(session.auth)
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses an anonymous caller", async () => {
    await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: "Brand-New-Pass-2" })
      .expect(401);
  });
});
