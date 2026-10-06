import { describe, it, expect, vi } from 'vitest';
import { GoogleOAuth } from './google-oauth.js';
import { UpstreamError } from '../../lib/errors.js';

const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app/callback' };

function fetchJson(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('GoogleOAuth.buildAuthorizeUrl', () => {
  it('includes client id, redirect, scope, offline access and state', () => {
    const o = new GoogleOAuth(config);
    const url = o.buildAuthorizeUrl('reviewer-1');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('state=reviewer-1');
    expect(url).toContain('calendar.events');
  });
});

describe('GoogleOAuth.exchangeCode', () => {
  it('returns the refresh token', async () => {
    const o = new GoogleOAuth(config, fetchJson({ refresh_token: 'r', access_token: 'a' }));
    const r = await o.exchangeCode('code');
    expect(r.refreshToken).toBe('r');
  });

  it('throws UpstreamError when no refresh token returned', async () => {
    const o = new GoogleOAuth(config, fetchJson({ access_token: 'a' }));
    await expect(o.exchangeCode('code')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws UpstreamError on HTTP failure', async () => {
    const o = new GoogleOAuth(config, fetchJson({}, false));
    await expect(o.exchangeCode('code')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('GoogleOAuth.refreshAccessToken', () => {
  it('returns a fresh access token', async () => {
    const o = new GoogleOAuth(config, fetchJson({ access_token: 'fresh' }));
    expect(await o.refreshAccessToken('refresh')).toBe('fresh');
  });
});
