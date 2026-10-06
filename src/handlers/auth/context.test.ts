import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { getAuthContext, hasRole } from './context.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import { UserRole } from '../../domain/enums.js';

function eventWithClaims(
  claims: Record<string, unknown> | undefined,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('getAuthContext', () => {
  it('extracts userId, email, and roles from array groups claim', () => {
    const ctx = getAuthContext(
      eventWithClaims({
        sub: 'u1',
        email: 'ana@example.com',
        'cognito:groups': ['admin'],
      }),
    );
    expect(ctx.userId).toBe('u1');
    expect(ctx.email).toBe('ana@example.com');
    expect(ctx.roles).toEqual([UserRole.ADMIN]);
  });

  it('parses groups from a bracketed string', () => {
    const ctx = getAuthContext(
      eventWithClaims({ sub: 'u2', 'cognito:groups': '[revisor]' }),
    );
    expect(ctx.roles).toEqual([UserRole.REVIEWER]);
  });

  it('parses groups from a space-separated string', () => {
    const ctx = getAuthContext(
      eventWithClaims({ sub: 'u3', 'cognito:groups': 'admin revisor' }),
    );
    expect(ctx.roles).toContain(UserRole.ADMIN);
    expect(ctx.roles).toContain(UserRole.REVIEWER);
  });

  it('ignores unknown groups', () => {
    const ctx = getAuthContext(
      eventWithClaims({ sub: 'u4', 'cognito:groups': ['superuser', 'admin'] }),
    );
    expect(ctx.roles).toEqual([UserRole.ADMIN]);
  });

  it('returns empty roles when no groups claim', () => {
    const ctx = getAuthContext(eventWithClaims({ sub: 'u5' }));
    expect(ctx.roles).toEqual([]);
  });

  it('throws UnauthenticatedError when no claims', () => {
    expect(() => getAuthContext(eventWithClaims(undefined))).toThrow(UnauthenticatedError);
  });

  it('throws UnauthenticatedError when sub is missing', () => {
    expect(() => getAuthContext(eventWithClaims({ email: 'x@y.com' }))).toThrow(
      UnauthenticatedError,
    );
  });

  it('leaves email undefined when absent', () => {
    const ctx = getAuthContext(eventWithClaims({ sub: 'u6' }));
    expect(ctx.email).toBeUndefined();
  });
});

describe('hasRole', () => {
  it('returns true when role is present', () => {
    expect(hasRole({ userId: 'u1', roles: [UserRole.ADMIN] }, UserRole.ADMIN)).toBe(true);
  });

  it('returns false when role is absent', () => {
    expect(hasRole({ userId: 'u1', roles: [UserRole.REVIEWER] }, UserRole.ADMIN)).toBe(false);
  });
});
