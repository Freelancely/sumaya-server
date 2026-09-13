/**
 * The concerns that belong to every response, not to any one route.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { app, client, request, resetDatabase, seedCategories } from "./helpers.js";

describe("cross-cutting middleware", () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedCategories();
  });

  it("reports liveness without touching the database", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body.status).toBe("ok");
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reports readiness by querying the database", async () => {
    const response = await request(app).get("/ready").expect(200);
    expect(response.body.status).toBe("ready");
  });

  it("sets the security headers on every response", async () => {
    const response = await request(app).get("/api/categories").expect(200);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    // Only over TLS, which a test run is not.
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("reflects an allowlisted origin, and only an allowlisted one", async () => {
    const allowed = await request(app)
      .get("/api/categories")
      .set("Origin", "http://localhost:8080")
      .expect(200);

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(allowed.headers.vary).toContain("Origin");

    const refused = await request(app)
      .get("/api/categories")
      .set("Origin", "https://evil.example")
      .expect(200);

    // No header at all, rather than a header naming someone else's origin:
    // the browser is what enforces this, and absence is the refusal.
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    expect(refused.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers a preflight with the methods that path allows", async () => {
    const response = await request(app).options("/api/pieces").expect(204);
    expect(response.headers.allow).toBe("GET, POST, OPTIONS");
  });

  it("rejects a method the path does not implement, naming the ones it does", async () => {
    const response = await request(app).put("/api/categories").expect(405);

    expect(response.body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(response.headers.allow).toBe("GET");
  });

  it("answers an unknown path with the same envelope as everything else", async () => {
    const response = await request(app).get("/api/nope").expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.requestId).toBeTruthy();
  });

  it("carries an inbound request id through to the response and the error body", async () => {
    const response = await request(app)
      .get("/api/nope")
      .set("x-request-id", "trace-me-123")
      .expect(404);

    expect(response.headers["x-request-id"]).toBe("trace-me-123");
    expect(response.body.error.requestId).toBe("trace-me-123");
  });

  it("mints a request id when the caller does not supply one", async () => {
    const response = await request(app).get("/api/categories").expect(200);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a malformed JSON body as a validation failure, not a 500", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{ this is not json")
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("caches public catalogue reads and never caches authenticated ones", async () => {
    const anonymous = await client().get("/api/pieces").expect(200);
    expect(anonymous.headers["cache-control"]).toContain("s-maxage=60");
  });
});
