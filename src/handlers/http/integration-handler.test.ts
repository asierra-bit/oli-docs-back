import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler, __setDeps } from './integration-handler.js';
import type { IntegrationHandlerDeps } from './integration-handler.js';

function makeEvent(opts: {
  method: 'GET' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  anonymous?: boolean;
  userId?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims = opts.anonymous
    ? undefined
    : { sub: opts.userId ?? 'rev-1', 'cognito:groups': ['revisor'] };
  return {
    requestContext: {
      http: { method: opts.method, path: opts.path },
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
    queryStringParameters: opts.query,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function mockDeps() {
  const oauth = {
    buildAuthorizeUrl: vi.fn().mockReturnValue('https://accounts.google/auth?state=rev-1'),
    exchangeCode: vi.fn().mockResolvedValue({ refreshToken: 'r', accessToken: 'a' }),
    refreshAccessToken: vi.fn(),
  };
  const tokenStore = {
    getRefreshToken: vi.fn(),
    saveRefreshToken: vi.fn().mockResolvedValue(undefined),
    deleteRefreshToken: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(undefined),
    consumeState: vi.fn().mockResolvedValue('rev-1'),
  };
  __setDeps({ oauth, tokenStore } as unknown as IntegrationHandlerDeps);
  return { oauth, tokenStore };
}

describe('integration-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDeps(null);
  });

  it('401 when unauthenticated', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/integrations/google/authorize-url', anonymous: true }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('authorize-url returns the consent URL and persists a random state', async () => {
    const { oauth, tokenStore } = mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/integrations/google/authorize-url' }),
    );
    expect(res.statusCode).toBe(200);
    // State is a random value bound server-side to the reviewer, not the userId.
    expect(tokenStore.saveState).toHaveBeenCalledTimes(1);
    const [stateArg, reviewerArg] = tokenStore.saveState.mock.calls[0]!;
    expect(reviewerArg).toBe('rev-1');
    expect(stateArg).not.toBe('rev-1');
    expect(oauth.buildAuthorizeUrl).toHaveBeenCalledWith(stateArg);
    expect(JSON.parse(res.body as string).authorizeUrl).toContain('accounts.google');
  });

  it('callback consumes the state and stores the token for the bound reviewer', async () => {
    const { oauth, tokenStore } = mockDeps();
    tokenStore.consumeState.mockResolvedValue('rev-42');
    const res = await handler(
      makeEvent({
        method: 'GET',
        path: '/v1/integrations/google/callback',
        query: { code: 'auth-code', state: 'random-state' },
        anonymous: true, // browser redirect carries no JWT
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(tokenStore.consumeState).toHaveBeenCalledWith('random-state');
    expect(oauth.exchangeCode).toHaveBeenCalledWith('auth-code');
    expect(tokenStore.saveRefreshToken).toHaveBeenCalledWith('rev-42', 'r');
  });

  it('callback without a code returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/integrations/google/callback', query: {}, anonymous: true }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('callback with an invalid/expired state returns 403', async () => {
    const { tokenStore } = mockDeps();
    tokenStore.consumeState.mockResolvedValue(null);
    const res = await handler(
      makeEvent({
        method: 'GET',
        path: '/v1/integrations/google/callback',
        query: { code: 'c', state: 'stale' },
        anonymous: true,
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(tokenStore.saveRefreshToken).not.toHaveBeenCalled();
  });

  it('callback surfaces a Google consent error as 502', async () => {
    const { tokenStore } = mockDeps();
    const res = await handler(
      makeEvent({
        method: 'GET',
        path: '/v1/integrations/google/callback',
        query: { error: 'access_denied', error_description: 'user denied' },
        anonymous: true,
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(tokenStore.consumeState).not.toHaveBeenCalled();
  });

  it('DELETE unlinks the calendar (204)', async () => {
    const { tokenStore } = mockDeps();
    const res = await handler(
      makeEvent({ method: 'DELETE', path: '/v1/integrations/google' }),
    );
    expect(res.statusCode).toBe(204);
    expect(tokenStore.deleteRefreshToken).toHaveBeenCalledWith('rev-1');
  });
});
