import type { TimeSlot } from '../../domain/entities.js';
import { logger } from '../../lib/logger.js';
import type { GoogleOAuth } from './google-oauth.js';
import type { OAuthTokenStore } from './token-store.js';
import {
  ScheduleReason,
  type CalendarProvider,
  type FreeBusyQuery,
  type ScheduleRequest,
  type ScheduleResult,
} from './types.js';

const FREEBUSY_ENDPOINT = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/**
 * Google Calendar implementation of CalendarProvider (R6).
 *
 * Per-reviewer OAuth refresh tokens come from the token store. When a reviewer
 * has not linked their calendar, operations degrade gracefully:
 * `getBusy` returns [] and `schedule` returns scheduled:false with a reason,
 * so the flow is never blocked (R6.5). API errors are reported the same way
 * (R6.6) rather than thrown.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly oauth: GoogleOAuth,
    private readonly tokenStore: OAuthTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getBusy(q: FreeBusyQuery): Promise<TimeSlot[]> {
    const accessToken = await this.accessTokenFor(q.reviewerId);
    if (!accessToken) return [];

    try {
      const res = await this.fetchImpl(FREEBUSY_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ timeMin: q.from, timeMax: q.to, items: [{ id: 'primary' }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        calendars?: { primary?: { busy?: { start: string; end: string }[] } };
      };
      return (json.calendars?.primary?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
    } catch (err) {
      // Treat freebusy failures as "no availability info" rather than blocking.
      logger.warn('Google freeBusy failed', {
        reviewerId: q.reviewerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async schedule(req: ScheduleRequest): Promise<ScheduleResult> {
    const accessToken = await this.accessTokenFor(req.reviewerId);
    if (!accessToken) {
      return { scheduled: false, reason: ScheduleReason.NOT_AUTHORIZED };
    }

    try {
      const res = await this.fetchImpl(EVENTS_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          summary: req.summary,
          description: req.description,
          start: { dateTime: req.slot.start },
          end: { dateTime: req.slot.end },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { id?: string };
      return { scheduled: true, externalEventId: json.id };
    } catch (err) {
      logger.warn('Google event creation failed', {
        reviewerId: req.reviewerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { scheduled: false, reason: ScheduleReason.API_ERROR };
    }
  }

  /** Resolve a fresh access token for a reviewer, or null if not linked. */
  private async accessTokenFor(reviewerId: string): Promise<string | null> {
    const refreshToken = await this.tokenStore.getRefreshToken(reviewerId);
    if (!refreshToken) return null;
    try {
      return await this.oauth.refreshAccessToken(refreshToken);
    } catch (err) {
      logger.warn('Google token refresh failed', {
        reviewerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
