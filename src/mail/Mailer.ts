/**
 * The mail seam.
 *
 * Services depend on this interface, never on Resend. Swapping provider — or
 * dropping in a recording fake for a test — means adding a class, not editing
 * anything that sends mail.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Always send one: it is what spam filters read. */
  text: string;
  /**
   * Where a reply should go, when that is not the sending address. Forwarded
   * mail (an enquiry from the public form) needs it: the message is sent from
   * the verified domain, but the person to answer is the visitor.
   */
  replyTo?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}
