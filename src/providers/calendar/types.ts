import type { TimeSlot } from '../../domain/entities.js';

/**
 * Calendar provider abstraction for scheduling review blocks (R6).
 * Scheduling logic depends only on this interface so the Google implementation
 * can be swapped with a fake in tests.
 */

export interface FreeBusyQuery {
  reviewerId: string;
  from: string; // ISO 8601
  to: string; // ISO 8601
}

export interface ScheduleRequest {
  reviewerId: string;
  slot: TimeSlot;
  summary: string;
  description: string;
}

export interface ScheduleResult {
  scheduled: boolean;
  externalEventId?: string;
  /** Reason when not scheduled, e.g. "calendar_not_authorized". */
  reason?: string;
}

export interface CalendarProvider {
  /** Busy intervals for the reviewer within the window. */
  getBusy(q: FreeBusyQuery): Promise<TimeSlot[]>;
  /** Create a calendar event; returns scheduled:false with a reason on soft failures. */
  schedule(req: ScheduleRequest): Promise<ScheduleResult>;
}

/** Soft-failure reasons that must not break the scheduling flow (R6.5, R6.6). */
export const ScheduleReason = {
  NOT_AUTHORIZED: 'calendar_not_authorized',
  API_ERROR: 'calendar_api_error',
  NO_FREE_SLOT: 'no_free_slot',
} as const;

export type { TimeSlot };
