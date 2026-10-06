/**
 * Domain error hierarchy.
 *
 * Each error maps to a well-known error code that handlers translate
 * to the appropriate HTTP status and response body (R11.2).
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Map from ErrorCode to HTTP status code. */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPSTREAM_ERROR: 502,
};

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export interface ErrorDetail {
  field?: string;
  issue?: string;
  [key: string]: unknown;
}

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly details: ErrorDetail[];

  constructor(code: ErrorCode, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  /** HTTP status derived from the error code. */
  get statusCode(): number {
    return ERROR_STATUS_MAP[this.code];
  }

  /** Serialise to the uniform API error shape (R11.2). */
  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details.length > 0 ? this.details : undefined,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Concrete errors
// ---------------------------------------------------------------------------

export class ValidationError extends DomainError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super(ErrorCode.VALIDATION_ERROR, message, details);
    this.name = 'ValidationError';
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super(ErrorCode.UNAUTHENTICATED, message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Insufficient permissions') {
    super(ErrorCode.FORBIDDEN, message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(ErrorCode.NOT_FOUND, `${entity} '${id}' not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super(ErrorCode.CONFLICT, message, details);
    this.name = 'ConflictError';
  }
}

export class UpstreamError extends DomainError {
  constructor(service: string, message: string) {
    super(ErrorCode.UPSTREAM_ERROR, `${service}: ${message}`);
    this.name = 'UpstreamError';
  }
}
