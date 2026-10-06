import { describe, it, expect, vi } from 'vitest';
import {
  ReviewRecordService,
  parseRecordId,
  formatRecordId,
} from './review-record-service.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import { Permission, ReviewRecordStatus, UserRole } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import type { AuthContext } from '../handlers/auth/context.js';
import type { Assignment, Document, ReviewRecord } from '../domain/entities.js';

const owner: AuthContext = { userId: 'u1', roles: [UserRole.REVIEWER] };
const other: AuthContext = { userId: 'u2', roles: [UserRole.REVIEWER] };
const admin: AuthContext = { userId: 'admin-1', roles: [UserRole.ADMIN] };

const RECORD_ID = 'd1#u1';

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    documentId: 'd1',
    reviewerId: 'u1',
    status: ReviewRecordStatus.PENDING,
    scheduled: { done: true },
    createdAt: 'now',
    ...overrides,
  };
}

function makeDeps(opts?: {
  record?: ReviewRecord | null;
  permission?: Permission;
  moduleId?: string;
}) {
  const stored = opts && 'record' in opts ? opts.record : record();
  const doc: Document = {
    id: 'd1',
    name: 'g.md',
    s3Key: 'documents/d1.md',
    status: 'in_review',
    moduleId: opts?.moduleId ?? 'm1',
    approvalPolicy: 'all',
    createdAt: 'now',
  };
  const assignment: Assignment | null =
    opts?.permission === undefined
      ? { reviewerId: 'u1', moduleId: 'm1', permission: Permission.EDIT, createdAt: 'now' }
      : { reviewerId: 'u1', moduleId: 'm1', permission: opts.permission, createdAt: 'now' };

  const events = new FakeEventPublisher();
  const deps = {
    reviewRecordRepo: {
      get: vi.fn().mockResolvedValue(stored),
      put: vi.fn().mockImplementation(async (r: ReviewRecord) => r),
      listForReviewer: vi.fn().mockResolvedValue([record()]),
    },
    annotationRepo: {
      putAnnotation: vi.fn().mockImplementation(async (a) => a),
      putSectionVerdict: vi.fn().mockImplementation(async (v) => v),
      listAnnotations: vi.fn().mockResolvedValue([]),
      listSectionVerdicts: vi.fn().mockResolvedValue([]),
      deleteAnnotation: vi.fn(),
    },
    assignmentRepo: { get: vi.fn().mockResolvedValue(assignment) },
    documentRepo: { get: vi.fn().mockResolvedValue(doc) },
    events,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { deps: deps as any, events };
}

describe('record id helpers', () => {
  it('round-trips', () => {
    expect(formatRecordId(parseRecordId('d1#u1'))).toBe('d1#u1');
  });
  it('rejects malformed ids', () => {
    expect(() => parseRecordId('nohash')).toThrow(ValidationError);
    expect(() => parseRecordId('#u1')).toThrow(ValidationError);
    expect(() => parseRecordId('d1#')).toThrow(ValidationError);
  });
});

describe('ReviewRecordService.listMine', () => {
  it('returns the reviewer records', async () => {
    const { deps } = makeDeps();
    const result = await new ReviewRecordService(deps).listMine(owner);
    expect(result).toHaveLength(1);
    expect(deps.reviewRecordRepo.listForReviewer).toHaveBeenCalledWith('u1');
  });
});

describe('ReviewRecordService.get', () => {
  it('returns record with annotations and verdicts for the owner', async () => {
    const { deps } = makeDeps();
    const detail = await new ReviewRecordService(deps).get(owner, RECORD_ID);
    expect(detail.record.documentId).toBe('d1');
    expect(detail.annotations).toEqual([]);
    expect(detail.sectionVerdicts).toEqual([]);
  });

  it('forbids access to another reviewer record (403)', async () => {
    const { deps } = makeDeps();
    await expect(new ReviewRecordService(deps).get(other, RECORD_ID)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('allows an admin to read any record', async () => {
    const { deps } = makeDeps();
    await expect(new ReviewRecordService(deps).get(admin, RECORD_ID)).resolves.toBeDefined();
  });

  it('404 when the record does not exist', async () => {
    const { deps } = makeDeps({ record: null });
    await expect(new ReviewRecordService(deps).get(owner, RECORD_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('ReviewRecordService write operations', () => {
  it('addAnnotation persists for an edit-permission owner', async () => {
    const { deps } = makeDeps({ permission: Permission.EDIT });
    const a = await new ReviewRecordService(deps).addAnnotation(
      owner,
      RECORD_ID,
      { type: 'document' },
      'looks good',
    );
    expect(a.text).toBe('looks good');
    expect(deps.annotationRepo.putAnnotation).toHaveBeenCalled();
  });

  it('read-only permission cannot write (403)', async () => {
    const { deps } = makeDeps({ permission: Permission.READ });
    await expect(
      new ReviewRecordService(deps).addAnnotation(owner, RECORD_ID, { type: 'document' }, 'x'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('section annotation without sectionId is a validation error (400)', async () => {
    const { deps } = makeDeps({ permission: Permission.EDIT });
    await expect(
      new ReviewRecordService(deps).addAnnotation(owner, RECORD_ID, { type: 'section' }, 'x'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cannot modify a completed record (409)', async () => {
    const { deps } = makeDeps({ record: record({ status: ReviewRecordStatus.COMPLETED }) });
    await expect(
      new ReviewRecordService(deps).setDocumentVerdict(owner, RECORD_ID, 'correct'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('setSectionVerdict persists', async () => {
    const { deps } = makeDeps({ permission: Permission.EDIT });
    const v = await new ReviewRecordService(deps).setSectionVerdict(
      owner,
      RECORD_ID,
      's1',
      'incorrect',
    );
    expect(v.verdict).toBe('incorrect');
  });
});

describe('ReviewRecordService.submit', () => {
  it('rejects submit without a document verdict (400)', async () => {
    const { deps } = makeDeps({ permission: Permission.EDIT });
    await expect(new ReviewRecordService(deps).submit(owner, RECORD_ID)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('completes and publishes review_record.completed', async () => {
    const { deps, events } = makeDeps({ record: record({ documentVerdict: 'correct' }) });
    const result = await new ReviewRecordService(deps).submit(owner, RECORD_ID);
    expect(result.status).toBe(ReviewRecordStatus.COMPLETED);
    expect(result.submittedAt).toBeDefined();
    expect(events.events[0]!.type).toBe(SystemEventType.REVIEW_RECORD_COMPLETED);
  });

  it('triggers approval evaluation after a successful submit (R9.3)', async () => {
    const { deps } = makeDeps({ record: record({ documentVerdict: 'correct' }) });
    const approvalEvaluator = { evaluate: vi.fn().mockResolvedValue(undefined) };
    deps.approvalEvaluator = approvalEvaluator;
    await new ReviewRecordService(deps).submit(owner, RECORD_ID);
    expect(approvalEvaluator.evaluate).toHaveBeenCalledWith('d1');
  });

  it('submit still succeeds if approval evaluation throws (non-fatal)', async () => {
    const { deps } = makeDeps({ record: record({ documentVerdict: 'correct' }) });
    deps.approvalEvaluator = { evaluate: vi.fn().mockRejectedValue(new Error('boom')) };
    const result = await new ReviewRecordService(deps).submit(owner, RECORD_ID);
    expect(result.status).toBe(ReviewRecordStatus.COMPLETED);
  });
});

describe('ReviewRecordService.reopen', () => {
  it('admin can reopen a completed record', async () => {
    const { deps } = makeDeps({ record: record({ status: ReviewRecordStatus.COMPLETED }) });
    const result = await new ReviewRecordService(deps).reopen(admin, RECORD_ID);
    expect(result.status).toBe(ReviewRecordStatus.PENDING);
    expect(result.submittedAt).toBeUndefined();
  });

  it('non-admin cannot reopen (403)', async () => {
    const { deps } = makeDeps();
    await expect(new ReviewRecordService(deps).reopen(owner, RECORD_ID)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
