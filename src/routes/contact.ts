/**
 * `/api/contact` — the public site's two outbound forms.
 *
 * These are the only unauthenticated endpoints that cause the server to do
 * something for a stranger, so the defences are the point of the file:
 *
 *   - a honeypot field that a person never sees and a bot always fills in,
 *   - rate limits counted per IP *and* per address, so neither one host nor
 *     one spoofed sender can flood the inbox,
 *   - a 202 in every non-error case, including for a submission that was
 *     dropped as spam, so a bot learns nothing from the response.
 *
 * Delivery is Resend, through the same mailer the password flows use — the API
 * key stays on this side, where a browser can never read it.
 */
import { Router } from "express";

import { env } from "../config/env.js";
import { getMailer } from "../mail/providers.js";
import { contactEnquiryEmail, newsletterSignupEmail } from "../mail/templates.js";
import { RateLimits } from "../http/rateLimit.js";
import { accepted } from "../http/respond.js";
import { mount } from "../http/route.js";
import { contactSchema, newsletterSchema } from "../validation/schemas.js";

export const contactRouter: Router = Router();

/** Counted against the address as well as the IP. */
const byEmail = (rule: { name: string; limit: number; windowSeconds: number }) => ({
  rule,
  by: (req: { body?: unknown }, ip: string) =>
    `${ip}:${String((req.body as { email?: string })?.email ?? "").toLowerCase()}`,
});

/**
 * POST /api/contact
 *
 * Sends the enquiry to `CONTACT_TO` with the visitor as the reply-to address.
 */
mount(contactRouter, "/", {
  POST: {
    body: contactSchema,
    rateLimits: [{ rule: RateLimits.contactByIp }, byEmail(RateLimits.contactByEmail)],
    async handler({ res, requestId, logger, body }) {
      if (body.website) {
        // A bot. Answer exactly as if it had gone through.
        logger.warn("Enquiry rejected by honeypot");
        accepted(res, requestId, { delivered: true });
        return;
      }

      await getMailer().send(
        contactEnquiryEmail({
          to: env.CONTACT_TO,
          name: body.name,
          email: body.email,
          phone: body.phone || undefined,
          subject: body.subject || undefined,
          message: body.message,
        }),
      );

      logger.info("Enquiry delivered");
      accepted(res, requestId, { delivered: true });
    },
  },
});

/**
 * POST /api/contact/newsletter
 *
 * Forwards the address so it can be added to the mailing list. There is no
 * subscriber table: the list lives with whoever sends the newsletter, and
 * storing addresses here would be a second copy to keep lawful and in sync.
 */
mount(contactRouter, "/newsletter", {
  POST: {
    body: newsletterSchema,
    rateLimits: [{ rule: RateLimits.contactByIp }, byEmail(RateLimits.contactByEmail)],
    async handler({ res, requestId, logger, body }) {
      if (body.website) {
        logger.warn("Newsletter signup rejected by honeypot");
        accepted(res, requestId, { delivered: true });
        return;
      }

      await getMailer().send(newsletterSignupEmail(env.CONTACT_TO, body.email));

      logger.info("Newsletter signup delivered");
      accepted(res, requestId, { delivered: true });
    },
  },
});
