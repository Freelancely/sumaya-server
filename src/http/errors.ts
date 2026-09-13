/**
 * The application's error vocabulary.
 *
 * Anything thrown that is an `AppError` is deliberate and safe to show a
 * client; anything else is a bug and becomes an opaque 500. That single rule is
 * what keeps stack traces and driver messages out of API responses, so throw an
 * `AppError` whenever a failure is expected rather than returning error shapes
 * up through every call site.
 */

/** Machine-readable codes. The frontend branches on these, never on `message`. */
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  UNAUTHORIZED: "UNAUTHORIZED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_INVALID: "TOKEN_INVALID",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  PIECE_NOT_FOUND: "PIECE_NOT_FOUND",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  CATEGORY_NOT_FOUND: "CATEGORY_NOT_FOUND",
  CONFLICT: "CONFLICT",
  SLUG_TAKEN: "SLUG_TAKEN",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  FEATURED_REQUIRED: "FEATURED_REQUIRED",
  IMAGE_LIMIT_REACHED: "IMAGE_LIMIT_REACHED",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM_FAILURE: "UPSTREAM_FAILURE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  /** Extra response headers this failure requires, e.g. `Retry-After`. */
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    options: { details?: unknown; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request payload is invalid.", details?: unknown) {
    super(400, ErrorCode.VALIDATION_FAILED, message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication is required.", code: ErrorCodeValue = ErrorCode.UNAUTHORIZED) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource.") {
    super(403, ErrorCode.FORBIDDEN, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.", code: ErrorCodeValue = ErrorCode.NOT_FOUND) {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with the current state.", code: ErrorCodeValue = ErrorCode.CONFLICT, details?: unknown) {
    super(409, code, message, { details });
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(allowed: string[]) {
    super(405, ErrorCode.METHOD_NOT_ALLOWED, `Method not allowed. Allowed: ${allowed.join(", ")}.`, {
      headers: { Allow: allowed.join(", ") },
    });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "The uploaded file is too large.") {
    super(413, ErrorCode.PAYLOAD_TOO_LARGE, message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = "That file type is not supported.") {
    super(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, ErrorCode.RATE_LIMITED, "Too many requests. Please try again shortly.", {
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
      details: { retryAfterSeconds },
    });
  }
}

/** A third party (Cloudinary, the mail provider) failed us, not the caller. */
export class ExternalServiceError extends AppError {
  constructor(service: string, cause?: unknown) {
    super(502, ErrorCode.UPSTREAM_FAILURE, `The ${service} service is currently unavailable.`, { cause });
  }
}
