import type { TimeSlot } from '../domain/entities.js';

/**
 * Find the earliest free slot of `durationMinutes` within [from, to] that does
 * not overlap any busy interval (R6.7). Returns null if no gap fits.
 *
 * The search steps forward from the end of each conflicting busy block, so it
 * always returns the earliest viable start.
 */
export function findFreeSlot(
  from: Date,
  to: Date,
  durationMinutes: number,
  busy: TimeSlot[],
): TimeSlot | null {
  const durationMs = durationMinutes * 60_000;
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
    .sort((a, b) => a.start - b.start);

  let cursor = from.getTime();
  const limit = to.getTime();

  for (const block of sorted) {
    if (block.end <= cursor) continue; // already past this block
    // Is there room before this block starts?
    if (block.start - cursor >= durationMs) {
      return toSlot(cursor, durationMs);
    }
    // Otherwise jump past the block.
    cursor = Math.max(cursor, block.end);
  }

  if (limit - cursor >= durationMs) {
    return toSlot(cursor, durationMs);
  }
  return null;
}

function toSlot(startMs: number, durationMs: number): TimeSlot {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + durationMs).toISOString(),
  };
}

/**
 * Estimate the review block duration from the document's word count,
 * clamped to [min, max] (R6.4).
 */
export function estimateDurationMinutes(
  wordCount: number,
  opts: { wordsPerMin: number; min: number; max: number },
): number {
  const raw = Math.ceil(wordCount / Math.max(1, opts.wordsPerMin));
  return Math.min(opts.max, Math.max(opts.min, raw));
}
