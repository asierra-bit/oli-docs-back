import { describe, it, expect, vi } from 'vitest';
import { SchedulingService } from './scheduling-service.js';
import { NotFoundError } from '../lib/errors.js';
import { ReviewRecordStatus } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import { FakeCalendarProvider } from '../providers/calendar/fake-calendar-provider.js';
import { ScheduleReason } from '../providers/calendar/types.js';
import type { Document, Assignment, ReviewRecord } from '../domain/entities.js';

const NOW = new Date('2026-01-01T09:00:00.000Z');

function doc(moduleId?: string): Document {
  const base: Document = {
    id: 'd1',
    name: 'guide.md',
    s3Key: 'documents/d1.md',
    status: 'classified',
    approvalPolicy: 'all',
    createdAt: 'now',
  };
  // Only attach moduleId when provided so `doc()` / `docWithoutModule()` have none.
  return moduleId ? { ...base, moduleId } : base;
}

function docWithModule(): Document {
  return doc('m1');
}

function assignment(reviewerId: string): Assignment {
  return { reviewerId, moduleId: 'm1', permission: 'edit', createdAt: 'now' };
}

function makeDeps(opts?: {
  document?: Document | null;
  assignments?: Assignment[];
  content?: string;
  alreadyScheduled?: boolean;
}) {
  const saved: ReviewRecord[] = [];
  const calendar = new FakeCalendarProvider();
  const events = new FakeEventPublisher();
  const deps = {
    documentRepo: {
      get: vi
        .fn()
        .mockResolvedValue(opts && 'document' in opts ? opts.document : docWithModule()),
    },
    assignmentRepo: {
      listForModule: vi.fn().mockResolvedValue(opts?.assignments ?? [assignment('u1')]),
    },
    reviewRecordRepo: {
      put: vi.fn().mockImplementation(async (r: ReviewRecord) => {
        saved.push(r);
        return r;
      }),
      hasRecordsForDocument: vi.fn().mockResolvedValue(opts?.alreadyScheduled ?? false),
    },
    documentStore: {
      readContent: vi.fn().mockResolvedValue(opts?.content ?? 'word '.repeat(100)),
    },
    calendar,
    events,
    config: {
      schedulingWindowDays: 7,
      wordsPerMin: 200,
      minReviewMinutes: 15,
      maxReviewMinutes: 120,
    },
    now: () => NOW,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { deps: deps as any, saved, calendar, events };
}

describe('SchedulingService.scheduleFor', () => {
  it('creates one pending review record per reviewer and schedules each', async () => {
    const { deps, saved, calendar } = makeDeps({
      assignments: [assignment('u1'), assignment('u2')],
    });
    const records = await new SchedulingService(deps).scheduleFor('d1');

    expect(records).toHaveLength(2);
    expect(saved).toHaveLength(2);
    expect(saved.every((r) => r.status === ReviewRecordStatus.PENDING)).toBe(true);
    expect(calendar.scheduled).toHaveLength(2);
    expect(saved[0]!.scheduled.done).toBe(true);
    expect(saved[0]!.scheduled.eventId).toBeDefined();
  });

  it('publishes a review.scheduled event per record', async () => {
    const { deps, events } = makeDeps({ assignments: [assignment('u1')] });
    await new SchedulingService(deps).scheduleFor('d1');
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.type).toBe(SystemEventType.REVIEW_SCHEDULED);
  });

  it('marks "not scheduled" with a reason when the reviewer has not authorized', async () => {
    const { deps, saved, calendar } = makeDeps({ assignments: [assignment('u1')] });
    calendar.setMode('not_authorized');
    await new SchedulingService(deps).scheduleFor('d1');
    expect(saved[0]!.scheduled.done).toBe(false);
    expect(saved[0]!.scheduled.reason).toBe(ScheduleReason.NOT_AUTHORIZED);
  });

  it('marks not scheduled when there is no free slot', async () => {
    const { deps, saved, calendar } = makeDeps({ assignments: [assignment('u1')] });
    // Fully busy for the whole window.
    calendar.setBusy('u1', [
      { start: '2026-01-01T09:00:00.000Z', end: '2026-01-15T00:00:00.000Z' },
    ]);
    await new SchedulingService(deps).scheduleFor('d1');
    expect(saved[0]!.scheduled.done).toBe(false);
    expect(saved[0]!.scheduled.reason).toBe(ScheduleReason.NO_FREE_SLOT);
  });

  it('schedules into the first gap avoiding existing events (R6.7)', async () => {
    const { deps, calendar } = makeDeps({ assignments: [assignment('u1')] });
    calendar.setBusy('u1', [
      { start: '2026-01-01T09:00:00.000Z', end: '2026-01-01T10:00:00.000Z' },
    ]);
    await new SchedulingService(deps).scheduleFor('d1');
    expect(calendar.scheduled[0]!.slot.start).toBe('2026-01-01T10:00:00.000Z');
  });

  it('dedups: returns [] and schedules nothing when records already exist', async () => {
    const { deps, saved, calendar, events } = makeDeps({
      assignments: [assignment('u1')],
      alreadyScheduled: true,
    });
    const records = await new SchedulingService(deps).scheduleFor('d1');
    expect(records).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(calendar.scheduled).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });

  it('returns [] when the module has no reviewers', async () => {
    const { deps, saved } = makeDeps({ assignments: [] });
    const records = await new SchedulingService(deps).scheduleFor('d1');
    expect(records).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('throws NotFound for an unknown document', async () => {
    const { deps } = makeDeps({ document: null });
    await expect(new SchedulingService(deps).scheduleFor('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFound when the document has no module', async () => {
    const { deps } = makeDeps({ document: doc() });
    await expect(new SchedulingService(deps).scheduleFor('d1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
