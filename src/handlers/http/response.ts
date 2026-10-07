import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DomainError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Build a JSON success response. */
export function ok(body: unknown, statusCode = 200): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/** 201 Created. */
export function created(body: unknown): APIGatewayProxyStructuredResultV2 {
  return ok(body, 201);
}

/** 204 No Content. */
export function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, body: '' };
}

/**
 * 302 redirect to an absolute URL. Used by browser-reached routes (e.g. the
 * Google OAuth callback) that must return the user to the frontend rather than
 * render a JSON body.
 */
export function redirect(location: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 302,
    headers: { location },
    body: '',
  };
}

/**
 * Map a thrown error to a uniform HTTP error response (R11.2).
 * DomainErrors map to their declared status; anything else is a 500.
 */
export function errorResponse(err: unknown): APIGatewayProxyStructuredResultV2 {
  if (err instanceof DomainError) {
    return {
      statusCode: err.statusCode,
      headers: JSON_HEADERS,
      body: JSON.stringify(err.toResponse()),
    };
  }

  logger.error('Unhandled error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  return {
    statusCode: 500,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    }),
  };
}

/** Parse a JSON request body, returning {} when empty. */
export function parseJsonBody(body: string | undefined | null): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    // Let validation surface a clean error downstream.
    return {};
  }
}
