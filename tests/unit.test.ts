/**
 * The pieces worth testing in isolation: the rules that are pure functions, and
 * the ones whose failure mode is silent rather than a wrong status code.
 */
import { describe, expect, it } from "vitest";

import { hashPassword, PasswordTooLongError, verifyPassword } from "../src/auth/password.js";
import { generateOpaqueToken, hashToken, signAccessToken, tokensMatch, verifyAccessToken } from "../src/auth/tokens.js";
import { loadEnv } from "../src/config/env.js";
import { sniffImageType } from "../src/http/multipart.js";
import { slugifyStone } from "../src/pieces/pieceRepo.js";
import { slugifyName } from "../src/pieces/pieceService.js";
import { NOT_AN_IMAGE, PNG_1X1 } from "./helpers.js";

describe("passwords", () => {
  it("verifies a correct password and refuses a wrong one", async () => {
    const hash = await hashPassword("Correct-Horse-9");

    expect(hash).not.toContain("Correct-Horse-9");
    expect(await verifyPassword("Correct-Horse-9", hash)).toBe(true);
    expect(await verifyPassword("correct-horse-9", hash)).toBe(false);
  });

  it("refuses to hash beyond bcrypt's 72-byte input rather than truncating", async () => {
    // Truncation would mean two different long passphrases opening one account.
    await expect(hashPassword("a".repeat(73))).rejects.toBeInstanceOf(PasswordTooLongError);
  });

  it("refuses an over-length password at verification too", async () => {
    const hash = await hashPassword("a".repeat(72));
    expect(await verifyPassword("a".repeat(73), hash)).toBe(false);
  });
});

describe("tokens", () => {
  it("round-trips the claims an access token carries", () => {
    const { token, expiresIn } = signAccessToken({ sub: "user-1", role: "SUPERADMIN", pwdAt: 1_700_000_000_000 });

    const claims = verifyAccessToken(token);
    expect(claims).toMatchObject({ sub: "user-1", role: "SUPERADMIN", pwdAt: 1_700_000_000_000 });
    expect(claims.jti).toEqual(expect.any(String));
    expect(expiresIn).toBe(900);
  });

  it("refuses a tampered token", () => {
    const { token } = signAccessToken({ sub: "user-1", role: "SUPERADMIN", pwdAt: Date.now() });
    const [header, payload, signature] = token.split(".");
    const forged = [header, Buffer.from('{"sub":"admin","role":"SUPERADMIN"}').toString("base64url"), signature].join(".");

    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("refuses an unsigned token, whatever algorithm it names", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user-1", role: "SUPERADMIN", pwdAt: 1, jti: "x" })).toString("base64url");

    expect(() => verifyAccessToken(`${header}.${payload}.`)).toThrow();
  });

  it("hashes opaque tokens deterministically, and never stores the token itself", () => {
    const token = generateOpaqueToken();

    expect(token).toHaveLength(43); // 32 bytes, base64url
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it("compares tokens without leaking length-independent differences", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
  });
});

describe("image sniffing", () => {
  it("recognises the formats the API accepts", () => {
    expect(sniffImageType(PNG_1X1)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");

    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffImageType(webp)).toBe("image/webp");
  });

  it("rejects anything else, including a file that is merely named like an image", () => {
    expect(sniffImageType(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageType(Buffer.from("GIF89a-and-then-some"))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff]))).toBeNull();
  });
});

describe("slugs", () => {
  it("normalises a name into a url-safe slug", () => {
    expect(slugifyName("  Coral Bloom Ring  ")).toBe("coral-bloom-ring");
    expect(slugifyName("Étoile — n°2")).toBe("etoile-n-2");
    expect(slugifyName("a".repeat(120))).toHaveLength(80);
  });

  it("converges stone spellings on one identity", () => {
    expect(slugifyStone("Blue sapphire")).toBe("blue-sapphire");
    expect(slugifyStone("  blue   Sapphire ")).toBe("blue-sapphire");
  });
});

describe("the environment contract", () => {
  const valid = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    JWT_SECRET: "x".repeat(32),
    JWT_REFRESH_SECRET: "y".repeat(32),
  };

  it("fills in the defaults a development machine can rely on", () => {
    const parsed = loadEnv({ ...valid, STORAGE_DRIVER: "memory" } as NodeJS.ProcessEnv);

    expect(parsed.PORT).toBe(4000);
    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.TRUST_PROXY).toBe(false);
    expect(parsed.RATE_LIMITS_ENABLED).toBe(true);
    // No Resend key configured, so mail goes to the console rather than nowhere.
    expect(parsed.mailDriver).toBe("console");
    expect(parsed.corsOrigins).toEqual(["http://localhost:8080"]);
  });

  it("names every missing variable at once, rather than one per restart", () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });

  it("refuses a short signing secret", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: "too-short" } as NodeJS.ProcessEnv)).toThrowError(/JWT_SECRET/);
  });

  it("requires Cloudinary credentials when Cloudinary is the storage driver", () => {
    expect(() => loadEnv({ ...valid, STORAGE_DRIVER: "cloudinary" } as NodeJS.ProcessEnv)).toThrowError(
      /CLOUDINARY_CLOUD_NAME/,
    );
  });

  it("refuses to start a production process on the in-memory substitutes", () => {
    const production = {
      ...valid,
      NODE_ENV: "production",
      STORAGE_DRIVER: "memory",
      MAIL_DRIVER: "memory",
    } as NodeJS.ProcessEnv;

    // Both would silently discard real work — an upload that never lands, a
    // password reset nobody receives.
    expect(() => loadEnv(production)).toThrowError(/STORAGE_DRIVER/);
    expect(() => loadEnv(production)).toThrowError(/MAIL_DRIVER/);
  });

  it("refuses to start a production process with rate limits disabled", () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: "production",
        RATE_LIMITS_ENABLED: "false",
        STORAGE_DRIVER: "cloudinary",
        CLOUDINARY_CLOUD_NAME: "c",
        CLOUDINARY_API_KEY: "k",
        CLOUDINARY_API_SECRET: "s",
        RESEND_API_KEY: "re_123",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/RATE_LIMITS_ENABLED/);
  });

  it("accepts a fully configured production environment", () => {
    const parsed = loadEnv({
      ...valid,
      NODE_ENV: "production",
      CLOUDINARY_CLOUD_NAME: "sumaya",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      RESEND_API_KEY: "re_123",
      CORS_ORIGINS: "https://sumayahmurafie.com, https://www.sumayahmurafie.com",
      TRUST_PROXY: "true",
    } as NodeJS.ProcessEnv);

    expect(parsed.isProduction).toBe(true);
    expect(parsed.mailDriver).toBe("resend");
    expect(parsed.TRUST_PROXY).toBe(true);
    expect(parsed.corsOrigins).toEqual(["https://sumayahmurafie.com", "https://www.sumayahmurafie.com"]);
  });
});
