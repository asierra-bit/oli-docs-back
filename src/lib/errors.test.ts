import { describe, it, expect } from 'vitest';
import {
  DomainError,
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UpstreamError,
  ErrorCode,
  ERROR_STATUS_MAP,
} from './errors.js';

describe('DomainError hierarchy', () => {
  it('ValidationError has code VALIDATION_ERROR and status 400', () => {
    const err = new ValidationError('bad input', [{ field: 'name', issue: 'required' }]);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual([{ field: 'name', issue: 'required' }]);
    expect(err.message).toBe('bad input');
  });

  it('UnauthenticatedError defaults to 401', () => {
    const err = new UnauthenticatedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(err.message).toBe('Authentication required');
  });

  it('ForbiddenError defaults to 403', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('NotFoundError includes entity and id in message', () => {
    const err = new NotFoundError('Module', 'mod-123');
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('Module');
    expect(err.message).toContain('mod-123');
  });

  it('ConflictError has status 409', () => {
    const err = new ConflictError('already exists');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe(ErrorCode.CONFLICT);
  });

  it('UpstreamError includes service name and has status 502', () => {
    const err = new UpstreamError('Bedrock', 'throttled');
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('Bedrock');
    expect(err.message).toContain('throttled');
  });

  it('toResponse() produces the uniform error shape', () => {
    const err = new ValidationError('invalid', [{ field: 'email', issue: 'bad format' }]);
    const res = err.toResponse();

    expect(res).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'invalid',
        details: [{ field: 'email', issue: 'bad format' }],
      },
    });
  });

  it('toResponse() omits details when empty', () => {
    const err = new ForbiddenError('nope');
    const res = err.toResponse();
    expect(res.error.details).toBeUndefined();
  });

  it('ERROR_STATUS_MAP covers all ErrorCode values', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_STATUS_MAP[code]).toBeTypeOf('number');
    }
  });
});
