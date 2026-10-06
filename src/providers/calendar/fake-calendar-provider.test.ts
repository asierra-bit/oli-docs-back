import { describe, it, expect } from 'vitest';
import { FakeCalendarProvider } from './fake-calendar-provider.js';
import { ScheduleReason } from './types.js';

const slot = { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T10:30:00.000Z' };
const req = { reviewerId: 'u1', slot, summary: 's', description: 'd' };

describe('FakeCalendarProvider', () => {
  it('returns configured busy intervals', async () => {
    const p = new FakeCalendarProvider();
    p.setBusy('u1', [slot]);
    const busy = await p.getBusy({ reviewerId: 'u1', from: 'a', to: 'b' });
    expect(busy).toEqual([slot]);
  });

  it('schedules and records the request in ok mode', async () => {
    const p = new FakeCalendarProvider();
    const r = await p.schedule(req);
    expect(r.scheduled).toBe(true);
    expect(r.externalEventId).toBeDefined();
    expect(p.scheduled).toHaveLength(1);
  });

  it('reports not_authorized without scheduling', async () => {
    const p = new FakeCalendarProvider();
    p.setMode('not_authorized');
    const r = await p.schedule(req);
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe(ScheduleReason.NOT_AUTHORIZED);
    expect(p.scheduled).toHaveLength(0);
    expect(await p.getBusy({ reviewerId: 'u1', from: 'a', to: 'b' })).toEqual([]);
  });

  it('reports api_error', async () => {
    const p = new FakeCalendarProvider();
    p.setMode('api_error');
    const r = await p.schedule(req);
    expect(r.reason).toBe(ScheduleReason.API_ERROR);
  });
});
