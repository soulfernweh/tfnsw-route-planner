// Typed error classes and the client-facing error envelope.
//
// Design reference: "Error Handling" -> "Error Model".
//
// The backend distinguishes recoverable, user-facing conditions from upstream
// failures and maps each to a stable error `code`, a safe `message`, and an
// HTTP status. Error responses use a single JSON envelope shape:
//
//   { "error": { "code": string, "message": string } }
//
// SECURITY: The TfNSW API key and raw upstream (EFA) payloads MUST NEVER be
// included in an error's `code`, `message`, or the serialised envelope. Typed
// errors only carry curated, safe messages; unknown errors are collapsed to a
// generic internal error so that incidental details (stack traces, upstream
// bodies, headers) can never leak to clients or logs built from the envelope.

/**
 * Stable, machine-readable error codes returned to clients. These strings are
 * part of the API contract: clients may branch on them, so they must remain
 * stable across releases.
 */
export const ErrorCode = {
  VALIDATION: 'VALIDATION_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The client-facing JSON error envelope. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Base class for all typed application errors.
 *
 * Every concrete error carries:
 *  - `code`: a stable string identifier (see {@link ErrorCode}).
 *  - `message`: a safe, human-readable message free of secrets or raw payloads.
 *  - `httpStatus`: the HTTP status code to surface to the client.
 */
export abstract class AppError extends Error {
  /** Stable, machine-readable error code. */
  public readonly code: ErrorCode;
  /** HTTP status code associated with this error. */
  public readonly httpStatus: number;

  protected constructor(code: ErrorCode, httpStatus: number, message: string) {
    super(message);
    // Restore the prototype chain when targeting older runtimes / transpilers.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
  }

  /** Convert this error into the safe client-facing envelope. */
  public toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

/**
 * Invalid client input (HTTP 400).
 *
 * Examples: identical origin and destination, malformed query parameters.
 * Requirements: 2.5.
 */
export class ValidationError extends AppError {
  public constructor(message = 'The request was invalid.') {
    super(ErrorCode.VALIDATION, 400, message);
  }
}

/**
 * The upstream TfNSW API was unreachable or returned an error (HTTP 502/503).
 *
 * Defaults to 503 (Service Unavailable). Use 502 (Bad Gateway) when the upstream
 * responded but with an unusable/invalid result. The message is deliberately
 * generic: raw upstream payloads and the API key are never surfaced.
 * Requirements: 1.5, 2.6, 3.4.
 */
export class ServiceUnavailableError extends AppError {
  public constructor(
    message = 'The transport service is temporarily unavailable. Please try again.',
    httpStatus: 502 | 503 = 503,
  ) {
    super(ErrorCode.SERVICE_UNAVAILABLE, httpStatus, message);
  }
}

/**
 * A requested resource (e.g. an unknown journey id) does not exist (HTTP 404).
 * Requirements: 3.4.
 */
export class NotFoundError extends AppError {
  public constructor(message = 'The requested resource could not be found.') {
    super(ErrorCode.NOT_FOUND, 404, message);
  }
}

/**
 * Map any thrown value to the safe client-facing error envelope.
 *
 * Typed {@link AppError}s contribute their curated `code` and `message`. Any
 * other value (a plain `Error`, a string, an upstream object, etc.) is collapsed
 * to a generic internal error so that no incidental details — stack traces,
 * upstream payloads, headers, or the API key — can leak to clients.
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AppError) {
    return error.toEnvelope();
  }
  return {
    error: {
      code: ErrorCode.INTERNAL,
      message: 'An unexpected error occurred.',
    },
  };
}

/**
 * Resolve the HTTP status code for any thrown value. Typed errors report their
 * own status; everything else maps to 500 (Internal Server Error).
 */
export function toHttpStatus(error: unknown): number {
  return error instanceof AppError ? error.httpStatus : 500;
}
