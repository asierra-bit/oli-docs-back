import { describe, it, expect } from 'vitest';
import { ok, created, noContent, errorResponse, parseJsonBody } from './response.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';

describe('response helpers', () => {
  it('ok returns 200 with JSON body', () => {
    const res = ok({ a: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(res.body as string)).toEqual({ a: 1 });
  });

  it('created returns 201', () => {
    expect(created({ id: 'x' }).statusCode).toBe(201);
  });

  it('noContent returns 204 with empty body', () => {
    const res = noContent();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('errorResponse maps DomainError to its status and shape', () => {
    const res = errorResponse(new ValidationError('bad', [{ field: 'name', issue: 'required' }]));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body as string);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([{ field: 'name', issue: 'required' }]);
  });

  it('errorResponse maps NotFoundError to 404', () => {
    expect(errorResponse(new NotFoundError('Module', 'm1')).statusCode).toBe(404);
  });

  it('errorResponse maps unknown error to 500', () => {
    const res = errorResponse(new Error('boom'));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body as string);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('parseJsonBody parses valid JSON', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseJsonBody returns {} for empty/invalid', () => {
    expect(parseJsonBody(undefined)).toEqual({});
    expect(parseJsonBody('')).toEqual({});
    expect(parseJsonBody('not json')).toEqual({});
  });
});
