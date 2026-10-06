import { describe, it, expect, vi } from 'vitest';
import { ReviewTimeoutService } from './review-timeout-service.js';
import { ReviewRecordStatus } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import type { ReviewRecord } from '../domain/entities.js';

const NOW = new Date('2026-01-15T00:00:00.000Z');

function pending(reviewerId: string, createdAt: string): ReviewRecord {
  return {
    documentId: 'd1',
    reviewerId,
    status: ReviewRecordStatus.PENDING,
    scheduled: { done: true },
    createdAt,
  };
}

function makeDeps(records: ReviewRecord[], reviewTimeoutDays = 7) {
  const events = new FakeEventPublisher();
  const deps = {
    reviewRecordRepo: { listPending: vi.fn().mockResolvedValue(records) },
    events,
    config: { reviewTimeoutDays },
    now: () => NOW,
  };
  return { deps, events };
}

describe('ReviewTimeoutService.checkExpiredReviews', () => {
  it('flags a record older than the timeout and publishes an event', async () => {
    // created 10 days before NOW, timeout 7 → expired by ~3 days
    const { deps, events } = makeDeps([pending('u1', '2026-01-05T00:00:00.000Z')]);
    const expired = await new ReviewTimeoutService(deps).checkExpiredReviews();

    expect(expired).toHaveLength(1);
    expect(expired[0]!.reviewerId).toBe('u1');
    expect(expired[0]!.daysOverdue).toBe(10);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.type).toBe(SystemEventType.REVIEW_DEADLINE_EXPIRED);
    expect(events.events[0]!.resourceId).toBe('d1');
  });

  it('does not flag a record within the window', async () => {
    // created 3 days before NOW, timeout 7 → still within window
    const { deps, events } = makeDeps([pending('u1', '2026-01-12T00:00:00.000Z')]);
    const expired = await new ReviewTimeoutService(deps).checkExpiredReviews();
    expect(expired).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });

  it('publishes one event per expired record', async () => {
    const { deps, events } = makeDeps([
      pending('u1', '2026-01-01T00:00:00.000Z'),
      pending('u2', '2026-01-02T00:00:00.000Z'),
      pending('u3', '2026-01-14T00:00:00.000Z'), // within window
    ]);
    const expired = await new ReviewTimeoutService(deps).checkExpiredReviews();
    expect(expired).toHaveLength(2);
    expect(events.events).toHaveLength(2);
  });

  it('respects a custom timeout (14 days)', async () => {
    // created 10 days before NOW, timeout 14 → not expired
    const { deps } = makeDeps([pending('u1', '2026-01-05T00:00:00.000Z')], 14);
    const expired = await new ReviewTimeoutService(deps).checkExpiredReviews();
    expect(expired).toHaveLength(0);
  });

  it('does not mutate records (only reads + publishes)', async () => {
    const records = [pending('u1', '2026-01-01T00:00:00.000Z')];
    const { deps } = makeDeps(records);
    await new ReviewTimeoutService(deps).checkExpiredReviews();
    // listPending is the only repo call; there is no update/put on the repo mock.
    expect(deps.reviewRecordRepo.listPending).toHaveBeenCalledOnce();
    expect(records[0]!.status).toBe(ReviewRecordStatus.PENDING);
  });
});
