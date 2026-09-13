/**
 * Transactional email bodies.
 *
 * Kept as plain string builders rather than a template engine: there are two of
 * them, they must render in every mail client, and inline styles with a table
 * layout are what actually survives Outlook.
 */
import { env } from "../config/env.js";
import type { EmailMessage } from "./Mailer.js";

/** Anything interpolated into HTML is escaped — a name is still user input. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f5f3;font-family:Georgia,'Times New Roman',serif;color:#1f2430;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:32px;">
            <tr><td style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#8a8279;padding-bottom:24px;">SM Fine Jewellery</td></tr>
            <tr><td style="font-size:22px;line-height:1.3;padding-bottom:16px;">${escapeHtml(heading)}</td></tr>
            <tr><td style="font-size:15px;line-height:1.6;color:#3c4250;">${bodyHtml}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function passwordResetEmail(to: string, token: string, expiresInMinutes: number): EmailMessage {
  // `encodeURIComponent` matters: the token is base64url, and a raw `+` or `=`
  // in a query string would arrive mangled.
  const link = `${env.APP_URL}/admin/reset-password?token=${encodeURIComponent(token)}`;

  const text = [
    "We received a request to reset the password for your SM Fine Jewellery admin account.",
    "",
    `Reset your password: ${link}`,
    "",
    `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
    "If you did not request this, you can ignore this email — your password will not change.",
  ].join("\n");

  const html = layout(
    "Reset your password",
    `<p style="margin:0 0 16px;">We received a request to reset the password for your SM Fine Jewellery admin account.</p>
     <p style="margin:0 0 24px;">
       <a href="${escapeHtml(link)}" style="display:inline-block;background:#1f2430;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:4px;">Reset password</a>
     </p>
     <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">This link expires in ${expiresInMinutes} minutes and can only be used once.</p>
     <p style="margin:0;font-size:13px;color:#6b7280;">If you did not request this, you can ignore this email — your password will not change.</p>`,
  );

  return { to, subject: "Reset your SM Fine Jewellery password", html, text };
}

/**
 * Sent after a successful change or reset. It is the only signal an account
 * holder gets that someone else changed their password, so it is not optional.
 */
export function passwordChangedEmail(to: string): EmailMessage {
  const text = [
    "The password for your SM Fine Jewellery admin account was just changed.",
    "",
    "All other sessions have been signed out.",
    "If this was not you, contact the site administrator immediately.",
  ].join("\n");

  const html = layout(
    "Your password was changed",
    `<p style="margin:0 0 16px;">The password for your SM Fine Jewellery admin account was just changed, and all other sessions have been signed out.</p>
     <p style="margin:0;font-size:13px;color:#6b7280;">If this was not you, contact the site administrator immediately.</p>`,
  );

  return { to, subject: "Your SM Fine Jewellery password was changed", html, text };
}

/**
 * An enquiry from the public contact form.
 *
 * Addressed to the atelier, not to the visitor, so the subject leads with who
 * wrote it. `replyTo` carries the visitor's address: the message is sent from
 * the verified domain (a provider will not send as an arbitrary Gmail address),
 * so without it a reply would go back to the no-reply mailbox.
 */
export function contactEnquiryEmail(input: {
  to: string;
  name: string;
  email: string;
  phone?: string;
  subject?: string;
  message: string;
}): EmailMessage {
  const subject = input.subject?.trim() || "New enquiry";

  const rows: [string, string][] = [
    ["Name", input.name],
    ["Email", input.email],
    ...(input.phone ? ([["Phone", input.phone]] as [string, string][]) : []),
    ["Subject", subject],
  ];

  const text = [
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    input.message,
    "",
    "— Sent from the enquiry form on sumayahmurafie.com",
  ].join("\n");

  const html = layout(
    `Enquiry from ${input.name}`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:14px;">
       ${rows
         .map(
           ([label, value]) =>
             `<tr><td style="padding:2px 16px 2px 0;color:#8a8279;">${escapeHtml(label)}</td><td style="padding:2px 0;">${escapeHtml(value)}</td></tr>`,
         )
         .join("")}
     </table>
     <p style="margin:0 0 16px;white-space:pre-wrap;">${escapeHtml(input.message)}</p>
     <p style="margin:0;font-size:13px;color:#6b7280;">Reply directly to this email to reach ${escapeHtml(input.name)}.</p>`,
  );

  return { to: input.to, subject: `Enquiry — ${subject}`, html, text, replyTo: input.email };
}

/** A newsletter signup. One address, forwarded so it can be added to the list. */
export function newsletterSignupEmail(to: string, email: string): EmailMessage {
  const text = [
    `${email} asked to join the private newsletter.`,
    "",
    "Add them to the mailing list for private viewings, collection previews and",
    "the stories behind the craft.",
  ].join("\n");

  const html = layout(
    "New newsletter subscriber",
    `<p style="margin:0 0 16px;"><strong>${escapeHtml(email)}</strong> asked to join the private newsletter.</p>
     <p style="margin:0;font-size:13px;color:#6b7280;">Add them to the mailing list for private viewings, collection previews and the stories behind the craft.</p>`,
  );

  return { to, subject: "New newsletter subscriber", html, text, replyTo: email };
}
