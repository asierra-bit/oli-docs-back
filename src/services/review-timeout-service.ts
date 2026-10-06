import type { ReviewRecord } from '../domain/entities.js';
import { logger } from '../lib/logger.js';
import type { AppConfig } from '../lib/config.js';
import type { ReviewRecordRepo } from '../repositories/dynamo/review-record-repo.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';

export interface ReviewTimeoutServiceDeps {
  reviewRecordRepo: Pick<ReviewRecordRepo, 'listPending'>;
  events: EventPublisher;
  config: Pick<AppConfig, 'reviewTimeoutDays'>;
  now?: () => Date; // injectable clock for tests
}

export interface ExpiredReview {
  documentId: string;
  reviewerId: string;
  daysOverdue: number;
}

/**
 * Detects review records stuck in `pending` beyond the configured deadline
 * and notifies via an event (R9.9). It never mutates state — the admin decides
 * what to do (e.g. force-approval). Idempotent: safe to run repeatedly.
 */
export class ReviewTimeoutService {
  constructor(private readonly deps: ReviewTimeoutServiceDeps) {}

  async checkExpiredReviews(): Promise<ExpiredReview[]> {
    const now = this.deps.now ? this.deps.now() : new Date();
    const cutoffMs = now.getTime() - this.deps.config.reviewTimeoutDays * 86_400_000;

    const pending = await this.deps.reviewRecordRepo.listPending();
    const expired = pending
      .map((r) => this.toExpired(r, now, cutoffMs))
      .filter((e): e is ExpiredReview => e !== null);

    for (const e of expired) {
      await this.deps.events.publish({
        type: SystemEventType.REVIEW_DEADLINE_EXPIRED,
        resourceId: e.documentId,
        timestamp: now.toISOString(),
        detail: { reviewerId: e.reviewerId, daysOverdue: e.daysOverdue },
      });
    }

    logger.info('Review timeout check complete', {
      pendingCount: pending.length,
      expiredCount: expired.length,
    });
    return expired;
  }

  private toExpired(record: ReviewRecord, now: Date, cutoffMs: number): ExpiredReview | null {
    const createdMs = new Date(record.createdAt).getTime();
    if (Number.isNaN(createdMs) || createdMs > cutoffMs) return null;

    const daysOverdue = Math.floor((now.getTime() - createdMs) / 86_400_000);
    return { documentId: record.documentId, reviewerId: record.reviewerId, daysOverdue };
  }
}
