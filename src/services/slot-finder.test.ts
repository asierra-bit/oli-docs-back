import { describe, it, expect } from 'vitest';
import { findFreeSlot, estimateDurationMinutes } from './slot-finder.js';

const from = new Date('2026-01-01T09:00:00.000Z');
const to = new Date('2026-01-01T17:00:00.000Z');

describe('findFreeSlot', () => {
  it('returns the window start when there are no busy blocks', () => {
    const slot = findFreeSlot(from, to, 30, []);
    expect(slot?.start).toBe('2026-01-01T09:00:00.000Z');
    expect(slot?.end).toBe('2026-01-01T09:30:00.000Z');
  });

  it('skips past a busy block at the start', () => {
    const busy = [{ start: '2026-01-01T09:00:00.000Z', end: '2026-01-01T10:00:00.000Z' }];
    const slot = findFreeSlot(from, to, 30, busy);
    expect(slot?.start).toBe('2026-01-01T10:00:00.000Z');
  });

  it('finds a gap between two busy blocks', () => {
    const busy = [
      { start: '2026-01-01T09:00:00.000Z', end: '2026-01-01T10:00:00.000Z' },
      { start: '2026-01-01T10:45:00.000Z', end: '2026-01-01T12:00:00.000Z' },
    ];
    // 10:00–10:45 is a 45-min gap; a 30-min slot fits at 10:00.
    const slot = findFreeSlot(from, to, 30, busy);
    expect(slot?.start).toBe('2026-01-01T10:00:00.000Z');
    expect(slot?.end).toBe('2026-01-01T10:30:00.000Z');
  });

  it('does not place a slot that would overlap (gap too small)', () => {
    const busy = [
      { start: '2026-01-01T09:00:00.000Z', end: '2026-01-01T10:00:00.000Z' },
      { start: '2026-01-01T10:20:00.000Z', end: '2026-01-01T17:00:00.000Z' },
    ];
    // Only a 20-min gap; a 30-min slot cannot fit → null.
    const slot = findFreeSlot(from, to, 30, busy);
    expect(slot).toBeNull();
  });

  it('returns null when the window is fully busy', () => {
    const busy = [{ start: '2026-01-01T09:00:00.000Z', end: '2026-01-01T17:00:00.000Z' }];
    expect(findFreeSlot(from, to, 30, busy)).toBeNull();
  });

  it('ignores busy blocks entirely before the window', () => {
    const busy = [{ start: '2026-01-01T07:00:00.000Z', end: '2026-01-01T08:00:00.000Z' }];
    const slot = findFreeSlot(from, to, 60, busy);
    expect(slot?.start).toBe('2026-01-01T09:00:00.000Z');
  });
});

describe('estimateDurationMinutes', () => {
  const opts = { wordsPerMin: 200, min: 15, max: 120 };

  it('clamps to the minimum for short docs', () => {
    expect(estimateDurationMinutes(100, opts)).toBe(15);
  });

  it('scales with word count', () => {
    expect(estimateDurationMinutes(6000, opts)).toBe(30); // 6000/200 = 30
  });

  it('clamps to the maximum for long docs', () => {
    expect(estimateDurationMinutes(100000, opts)).toBe(120);
  });
});
