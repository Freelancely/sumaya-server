/**
 * Mailer implementations and the factory that picks one.
 *
 * Development deliberately gets the console mailer: password reset flows are
 * far easier to exercise when the link is printed in the terminal, and no real
 * address ever receives test mail.
 */
import { Resend } from "resend";

import { env } from "../config/env.js";
import { ExternalServiceError } from "../http/errors.js";
import { logger } from "../logging/logger.js";
import type { EmailMessage, Mailer } from "./Mailer.js";

export class ResendMailer implements Mailer {
  private readonly client: Resend;

  constructor(apiKey: string, private readonly from: string) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (error) {
      logger.error("Mail provider rejected the message", { provider: "resend", reason: error.message });
      throw new ExternalServiceError("email", error);
    }
  }
}

/** Prints the message instead of sending it. Development only. */
export class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<void> {
    logger.info("Email (not sent — console mailer)", {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * Keeps every message instead of sending it, so a test can read the reset link
 * the way a recipient would. Deliberately unbounded: a process that runs long
 * enough for that to matter should not be using this driver.
 */
export class MemoryMailer implements Mailer {
  readonly outbox: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
  }

  /** The most recent message sent to an address, which is the one that counts. */
  lastTo(email: string): EmailMessage | undefined {
    return [...this.outbox].reverse().find((message) => message.to === email);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

let cached: Mailer | undefined;

/**
 * Picks the implementation named by `MAIL_DRIVER`, which defaults to Resend
 * when a key is present and the console otherwise. The environment schema has
 * already refused to start a production process on anything but Resend, so the
 * fallbacks here cannot silently swallow a real password reset.
 */
export function getMailer(): Mailer {
  if (cached) return cached;

  switch (env.mailDriver) {
    case "resend":
      cached = new ResendMailer(env.RESEND_API_KEY!, env.MAIL_FROM);
      break;
    case "memory":
      cached = new MemoryMailer();
      break;
    default:
      logger.warn("Using the console mailer — no email will actually be sent.");
      cached = new ConsoleMailer();
  }

  return cached;
}

/** Test seam: drops the cached mailer so the next call rebuilds it. */
export function resetMailer(): void {
  cached = undefined;
}
