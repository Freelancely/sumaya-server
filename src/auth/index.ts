/**
 * Composition root for authentication.
 *
 * The wiring of concrete implementations to interfaces happens here and nowhere
 * else, so route files import one ready-made service and stay ignorant of which
 * repository or mail provider is behind it.
 */
import { getMailer } from "../mail/providers.js";
import { AuthService } from "./authService.js";
import { PrismaSessionRepository } from "./sessionRepo.js";

let cached: AuthService | undefined;

export function getAuthService(): AuthService {
  cached ??= new AuthService(new PrismaSessionRepository(), getMailer());
  return cached;
}

export { AuthService } from "./authService.js";
export type { AuthenticatedResult } from "./authService.js";
export { PrismaSessionRepository } from "./sessionRepo.js";
export type { SessionContext, SessionRepository } from "./sessionRepo.js";
