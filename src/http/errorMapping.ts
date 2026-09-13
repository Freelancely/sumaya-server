/**
 * The single translation from a thrown value to an HTTP response.
 *
 * Route handlers and the app-level error middleware both go through this, so a
 * failure raised inside a handler and one raised by a parser before the handler
 * ran produce the same envelope.
 */
import { ZodError } from "zod";

import { AppError, ErrorCode } from "./errors.js";
import type { ErrorBody } from "./respond.js";

export interface MappedError {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
  /** True when we broke rather than the caller — the line deserves an error log. */
  internal: boolean;
}

export function toErrorResponse(error: unknown, requestId: string): MappedError {
  if (error instanceof ZodError) {
    // Field-level detail is safe and genuinely useful — it describes what the
    // caller sent, not anything internal.
    const details = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: "The request payload is invalid.",
          details,
          requestId,
        },
      },
      internal: false,
    };
  }

  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details, requestId } },
      headers: error.headers,
      internal: error.status >= 500,
    };
  }

  // express.json rejects a malformed body with a SyntaxError carrying a status.
  const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
  if (error instanceof SyntaxError && status === 400) {
    return {
      status: 400,
      body: {
        error: { code: ErrorCode.VALIDATION_FAILED, message: "The request body is not valid JSON.", requestId },
      },
      internal: false,
    };
  }
  if (status === 413) {
    return {
      status: 413,
      body: { error: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: "The request body is too large.", requestId } },
      internal: false,
    };
  }

  const prismaCode = (error as { code?: string })?.code;
  if (prismaCode === "P2002") {
    const target = (error as { meta?: { target?: string[] } }).meta?.target;
    return {
      status: 409,
      body: {
        error: {
          code: ErrorCode.CONFLICT,
          message: "That value is already taken.",
          details: target ? { fields: target } : undefined,
          requestId,
        },
      },
      internal: false,
    };
  }
  if (prismaCode === "P2025") {
    return {
      status: 404,
      body: { error: { code: ErrorCode.NOT_FOUND, message: "The requested resource was not found.", requestId } },
      internal: false,
    };
  }

  // Anything unrecognised is a bug. The client gets a request id and nothing
  // else; the detail goes to the logs where it belongs.
  return {
    status: 500,
    body: { error: { code: ErrorCode.INTERNAL_ERROR, message: "Something went wrong on our end.", requestId } },
    internal: true,
  };
}
