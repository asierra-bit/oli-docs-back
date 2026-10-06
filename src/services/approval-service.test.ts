import { describe, it, expect, vi } from 'vitest';
import { ApprovalService } from './approval-service.js';
import { NotFoundError } from '../lib/errors.js';
import { DocumentStatus, ReviewRecordStatus, type Verdict } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import type { Document, ReviewRecord } from '../domain/entities.js';

function doc(policy: 'all' | 'any' = 'all'): Document {
  return {
    id: 'd1',
    name: 'g.md',
    s3Key: 'documents/d1.md',
    status: DocumentStatus.IN_REVIEW,
    moduleId: 'm1',
    approvalPolicy: policy,
    createdAt: 'now',
  };
}

function rec(reviewerId: string, verdict: Verdict | undefined, completed = true): ReviewRecord {
  return {
    documentId: 'd1',
    reviewerId,
    status: completed ? ReviewRecordStatus.COMPLETED : ReviewRecordStatus.PENDING,
    documentVerdict: verdict,
    scheduled: { done: true },
    createdAt: 'now',
  };
}

function makeDeps(opts: { document?: Document; records: ReviewRecord[] }) {
  const events = new FakeEventPublisher();
  const saved: Document[] = [];
  const deps = {
    documentRepo: {
      get: vi.fn().mockResolvedValue(opts.document ?? doc()),
      update: vi.fn().mockImplementation(async (d: Document) => {
        saved.push(d);
        return d;
      }),
    },
    reviewRecordRepo: { listForDocument: vi.fn().mockResolvedValue(opts.records) },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    events,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { deps: deps as any, events, saved };
}

describe('ApprovalService.evaluate', () => {
  it('returns pending when some records are not completed', async () => {
    const { deps, saved } = makeDeps({
      records: [rec('u1', 'correct'), rec('u2', undefined, false)],
    });
    const r = await new ApprovalService(deps).evaluate('d1');
    expect(r.decision).toBe('pending');
    expect(saved).toHaveLength(0);
  });

  it('returns pending when there are no records', async () => {
    const { deps } = makeDeps({ records: [] });
    expect((await new ApprovalService(deps).evaluate('d1')).decision).toBe('pending');
  });

  it('all + all correct → approved + event', async () => {
    const { deps, events } = makeDeps({
      document: doc('all'),
      records: [rec('u1', 'correct'), rec('u2', 'correct')],
    });
    const r = await new ApprovalService(deps).evaluate('d1');
    expect(r.decision).toBe('approved');
    expect(r.document.status).toBe(DocumentStatus.APPROVED);
    expect(r.document.approvalDecidedAt).toBeDefined();
    expect(events.events.at(-1)!.type).toBe(SystemEventType.DOCUMENT_APPROVED);
  });

  it('all + one incorrect → rejected', async () => {
    const { deps, events } = makeDeps({
      document: doc('all'),
      records: [rec('u1', 'correct'), rec('u2', 'incorrect')],
    });
    const r = await new ApprovalService(deps).evaluate('d1');
    expect(r.decision).toBe('rejected');
    expect(events.events.at(-1)!.type).toBe(SystemEventType.DOCUMENT_REJECTED);
  });

  it('any + at least one correct → approved', async () => {
    const { deps } = makeDeps({
      document: doc('any'),
      records: [rec('u1', 'incorrect'), rec('u2', 'correct')],
    });
    expect((await new ApprovalService(deps).evaluate('d1')).decision).toBe('approved');
  });

  it('any + all incorrect → rejected', async () => {
    const { deps } = makeDeps({
      document: doc('any'),
      records: [rec('u1', 'incorrect'), rec('u2', 'incorrect')],
    });
    expect((await new ApprovalService(deps).evaluate('d1')).decision).toBe('rejected');
  });

  it('throws NotFound for unknown document', async () => {
    const { deps } = makeDeps({ records: [] });
    deps.documentRepo.get.mockResolvedValue(null);
    await expect(new ApprovalService(deps).evaluate('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('ApprovalService.forceEvaluate', () => {
  it('excludes a pending reviewer and decides on the rest, recording exclusions', async () => {
    const { deps, saved } = makeDeps({
      document: doc('all'),
      records: [rec('u1', 'correct'), rec('u2', undefined, false)],
    });
    const r = await new ApprovalService(deps).forceEvaluate('d1', ['u2'], 'no-show', 'admin-1');
    expect(r.decision).toBe('approved');
    expect(saved[0]!.excludedRecords).toEqual([{ reviewerId: 'u2', reason: 'no-show' }]);
    // audits force_approval and approval_decided
    expect(deps.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'force_approval' }),
    );
  });

  it('rejects when all remaining verdicts are excluded (no verdicts left)', async () => {
    const { deps } = makeDeps({
      document: doc('all'),
      records: [rec('u1', undefined, false)],
    });
    const r = await new ApprovalService(deps).forceEvaluate('d1', ['u1'], 'no-show', 'admin-1');
    expect(r.decision).toBe('rejected');
  });
});
