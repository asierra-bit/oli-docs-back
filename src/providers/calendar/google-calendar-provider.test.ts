import { describe, it, expect, vi } from 'vitest';
import { GoogleCalendarProvider } from './google-calendar-provider.js';
import { GoogleOAuth } from './google-oauth.js';
import { ScheduleReason } from './types.js';
import type { OAuthTokenStore } from './token-store.js';

const slot = { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T10:30:00.000Z' };

function tokenStore(token: string | null): OAuthTokenStore {
  return {
    getRefreshToken: vi.fn().mockResolvedValue(token),
    saveRefreshToken: vi.fn(),
    deleteRefreshToken: vi.fn(),
    saveState: vi.fn(),
    consumeState: vi.fn(),
  };
}

function oauthReturning(accessToken: string): GoogleOAuth {
  const o = new GoogleOAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'r' });
  vi.spyOn(o, 'refreshAccessToken').mockResolvedValue(accessToken);
  return o;
}

function fetchJson(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('GoogleCalendarProvider.getBusy', () => {
  it('returns [] when the reviewer has not linked a calendar (R6.5)', async () => {
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore(null));
    expect(await p.getBusy({ reviewerId: 'u1', from: 'a', to: 'b' })).toEqual([]);
  });

  it('maps freeBusy response to TimeSlots', async () => {
    const f = fetchJson({ calendars: { primary: { busy: [slot] } } });
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore('refresh'), f);
    const busy = await p.getBusy({ reviewerId: 'u1', from: 'a', to: 'b' });
    expect(busy).toEqual([slot]);
  });

  it('returns [] on API failure (does not throw, R6.6)', async () => {
    const f = fetchJson({}, false);
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore('refresh'), f);
    expect(await p.getBusy({ reviewerId: 'u1', from: 'a', to: 'b' })).toEqual([]);
  });
});

describe('GoogleCalendarProvider.schedule', () => {
  const req = { reviewerId: 'u1', slot, summary: 's', description: 'd' };

  it('returns not_authorized when no token (R6.5)', async () => {
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore(null));
    const r = await p.schedule(req);
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe(ScheduleReason.NOT_AUTHORIZED);
  });

  it('creates an event and returns its id when authorized', async () => {
    const f = fetchJson({ id: 'evt-123' });
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore('refresh'), f);
    const r = await p.schedule(req);
    expect(r.scheduled).toBe(true);
    expect(r.externalEventId).toBe('evt-123');
  });

  it('returns api_error on failure without throwing (R6.6)', async () => {
    const f = fetchJson({}, false);
    const p = new GoogleCalendarProvider(oauthReturning('tok'), tokenStore('refresh'), f);
    const r = await p.schedule(req);
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe(ScheduleReason.API_ERROR);
  });
});
