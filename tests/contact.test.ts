/**
 * The public contact endpoints.
 *
 * These are the only unauthenticated endpoints that make the server do work for
 * a stranger, so what is asserted here is mostly the defences: that a valid
 * enquiry reaches the inbox with the visitor as the reply-to address, that a
 * honeypot submission is answered identically but delivers nothing, and that
 * the limits hold.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { app, mailbox, request, resetDatabase } from "./helpers.js";

const INBOX = "atelier-inbox@example.com";

const enquiry = (overrides: Record<string, unknown> = {}) => ({
  name: "Dana Al-Sabah",
  email: "dana@example.com",
  phone: "+965 5000 0000",
  subject: "A bespoke commission",
  message: "I have my grandmother's ring and would like to talk about reworking it.",
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
});

describe("POST /api/contact", () => {
  it("delivers the enquiry to the atelier, with the visitor as the reply-to", async () => {
    await request(app).post("/api/contact").send(enquiry()).expect(202);

    const sent = mailbox().lastTo(INBOX);
    expect(sent).toBeDefined();
    expect(sent?.subject).toBe("Enquiry — A bespoke commission");
    // Sent from the verified domain, so without this a reply would go to the
    // no-reply mailbox rather than to the person who wrote.
    expect(sent?.replyTo).toBe("dana@example.com");
    expect(sent?.text).toContain("grandmother's ring");
    expect(sent?.text).toContain("+965 5000 0000");
  });

  it("falls back to a generic subject when the visitor leaves it blank", async () => {
    await request(app)
      .post("/api/contact")
      .send(enquiry({ subject: "", phone: "" }))
      .expect(202);

    expect(mailbox().lastTo(INBOX)?.subject).toBe("Enquiry — New enquiry");
  });

  it("escapes markup in the HTML body rather than rendering it", async () => {
    await request(app)
      .post("/api/contact")
      .send(enquiry({ name: "<script>alert(1)</script>" }))
      .expect(202);

    const sent = mailbox().lastTo(INBOX);
    expect(sent?.html).not.toContain("<script>");
    expect(sent?.html).toContain("&lt;script&gt;");
  });

  it("answers a honeypot submission exactly like a real one, and sends nothing", async () => {
    const response = await request(app)
      .post("/api/contact")
      .send(enquiry({ website: "http://spam.example" }))
      .expect(202);

    // Identical body: a bot must not be able to tell it was caught.
    expect(response.body).toMatchObject({ delivered: true });
    expect(mailbox().outbox).toHaveLength(0);
  });

  it("rejects a malformed address and a message that says nothing", async () => {
    const bad = await request(app).post("/api/contact").send(enquiry({ email: "not-an-address" })).expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");

    await request(app).post("/api/contact").send(enquiry({ message: "hello" })).expect(400);
    expect(mailbox().outbox).toHaveLength(0);
  });

  // The throttling itself is asserted in `rate-limit.test.ts` — limits are off
  // for the rest of the suite, where every request comes from 127.0.0.1.
});

describe("POST /api/contact/newsletter", () => {
  it("forwards the address so it can be added to the list", async () => {
    await request(app).post("/api/contact/newsletter").send({ email: "reader@example.com" }).expect(202);

    const sent = mailbox().lastTo(INBOX);
    expect(sent?.subject).toBe("New newsletter subscriber");
    expect(sent?.text).toContain("reader@example.com");
  });

  it("drops a honeypot signup", async () => {
    await request(app)
      .post("/api/contact/newsletter")
      .send({ email: "bot@example.com", website: "http://spam.example" })
      .expect(202);

    expect(mailbox().outbox).toHaveLength(0);
  });

  it("rejects a malformed address", async () => {
    await request(app).post("/api/contact/newsletter").send({ email: "nope" }).expect(400);
  });
});
