import type { TimeSlot } from '../../domain/entities.js';
import type {
  CalendarProvider,
  FreeBusyQuery,
  ScheduleRequest,
  ScheduleResult,
} from './types.js';
import { ScheduleReason } from './types.js';

/**
 * Deterministic CalendarProvider for tests and offline runs.
 * Configurable busy intervals per reviewer and a schedule behaviour switch.
 */
export class FakeCalendarProvider implements CalendarProvider {
  private busyByReviewer = new Map<string, TimeSlot[]>();
  private mode: 'ok' | 'not_authorized' | 'api_error' = 'ok';
  public scheduled: ScheduleRequest[] = [];

  setBusy(reviewerId: string, slots: TimeSlot[]): void {
    this.busyByReviewer.set(reviewerId, slots);
  }

  setMode(mode: 'ok' | 'not_authorized' | 'api_error'): void {
    this.mode = mode;
  }

  async getBusy(q: FreeBusyQuery): Promise<TimeSlot[]> {
    if (this.mode === 'not_authorized') return [];
    return this.busyByReviewer.get(q.reviewerId) ?? [];
  }

  async schedule(req: ScheduleRequest): Promise<ScheduleResult> {
    if (this.mode === 'not_authorized') {
      return { scheduled: false, reason: ScheduleReason.NOT_AUTHORIZED };
    }
    if (this.mode === 'api_error') {
      return { scheduled: false, reason: ScheduleReason.API_ERROR };
    }
    this.scheduled.push(req);
    return { scheduled: true, externalEventId: `evt-${this.scheduled.length}` };
  }
}
