/**
 * Password hashing.
 *
 * bcryptjs rather than argon2 or the native bcrypt: both need a compiled
 * binary, which is fragile inside a serverless bundle. Cost 12 is the current
 * sensible default — roughly 250ms on the machines these functions run on,
 * which is slow enough to hurt an attacker and fast enough for a login.
 */
import bcrypt from "bcryptjs";

const COST = 12;

/**
 * bcrypt silently truncates its input at 72 bytes. Rejecting rather than
 * truncating avoids the surprise where two different long passphrases both
 * open the same account.
 */
const MAX_BYTES = 72;

export class PasswordTooLongError extends Error {
  constructor() {
    super("Password is too long. Use at most 72 bytes.");
  }
}

function assertLength(plain: string): void {
  if (Buffer.byteLength(plain, "utf8") > MAX_BYTES) throw new PasswordTooLongError();
}

export async function hashPassword(plain: string): Promise<string> {
  assertLength(plain);
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (Buffer.byteLength(plain, "utf8") > MAX_BYTES) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * A hash of a value nobody knows, compared against on the "no such user" branch
 * so that login and forgot-password take the same time whether or not the
 * account exists. Without it, response latency alone enumerates accounts.
 */
const DECOY_HASH = bcrypt.hashSync("sumaya-timing-equaliser-not-a-real-password", COST);

export async function burnComparison(plain: string): Promise<void> {
  await bcrypt.compare(plain, DECOY_HASH);
}
