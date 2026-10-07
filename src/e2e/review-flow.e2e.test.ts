import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentService } from '../services/document-service.js';
import { ClassificationService } from '../services/classification-service.js';
import { SchedulingService } from '../services/scheduling-service.js';
import { ReviewRecordService } from '../services/review-record-service.js';
import { ApprovalService } from '../services/approval-service.js';
import { AuditService } from '../services/audit-service.js';
import { runClassification } from '../handlers/workers/classification-worker.js';
import { runScheduling } from '../handlers/workers/scheduling-worker.js';
import { FakeAiProvider } from '../providers/ai/fake-ai-provider.js';
import { FakeCalendarProvider } from '../providers/calendar/fake-calendar-provider.js';
import { FakeEventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';
import { DocumentStatus, ReviewRecordStatus, UserRole } from '../domain/enums.js';
import type { AuthContext } from '../handlers/auth/context.js';
import type {
  Annotation,
  Assignment,
  Document,
  Module,
  ReviewRecord,
  SectionVerdict,
} from '../domain/entities.js';
import type { SchedulingMessage } from '../repositories/sqs/queue-sender.js';
import type { S3Event, SQSEvent } from 'aws-lambda';

/**
 * Lightweight end-to-end test (16.2). It wires the real services together over
 * in-memory repositories and the Fake providers/publisher, exercising the full
 * happy path WITHOUT any AWS calls:
 *   upload → confirm → classify (worker) → schedule (worker) →
 *   two reviewers review in parallel → submit → approval evaluation.
 */

// --- In-memory repositories --------------------------------------------------

class InMemoryDocumentRepo {
  docs = new Map<string, Document>();
  async put(d: Document) { this.docs.set(d.id, d); return d; }
  async update(d: Document) { const n = { ...d, updatedAt: new Date().toISOString() }; this.docs.set(d.id, n); return n; }
  async get(id: string) { return this.docs.get(id) ?? null; }
  async list() { return [...this.docs.values()]; }
  async updateStatus(id: string, status: Document['status']) {
    const d = this.docs.get(id); if (d) this.docs.set(id, { ...d, status });
  }
  async listByModule() { return []; }
  async hasDocumentsForModule() { return false; }
}

class InMemoryModuleRepo {
  mods = new Map<string, Module>();
  async get(id: string) { return this.mods.get(id) ?? null; }
  async list() { return [...this.mods.values()]; }
}

class InMemoryAssignmentRepo {
  byModule = new Map<string, Assignment[]>();
  byReviewerModule = new Map<string, Assignment>();
  add(a: Assignment) {
    const list = this.byModule.get(a.moduleId) ?? [];
    list.push(a); this.byModule.set(a.moduleId, list);
    this.byReviewerModule.set(`${a.reviewerId}#${a.moduleId}`, a);
  }
  async listForModule(moduleId: string) { return this.byModule.get(moduleId) ?? []; }
  async get(reviewerId: string, moduleId: string) {
    return this.byReviewerModule.get(`${reviewerId}#${moduleId}`) ?? null;
  }
}

class InMemoryReviewRecordRepo {
  records = new Map<string, ReviewRecord>();
  key(d: string, r: string) { return `${d}#${r}`; }
  async put(r: ReviewRecord) { this.records.set(this.key(r.documentId, r.reviewerId), r); return r; }
  async get(d: string, r: string) { return this.records.get(this.key(d, r)) ?? null; }
  async listForDocument(documentId: string) {
    return [...this.records.values()].filter((r) => r.documentId === documentId);
  }
  async listForReviewer(reviewerId: string) {
    return [...this.records.values()].filter((r) => r.reviewerId === reviewerId);
  }
  async hasRecordsForDocument(documentId: string) {
    return [...this.records.values()].some((r) => r.documentId === documentId);
  }
  async listPending() {
    return [...this.records.values()].filter((r) => r.status === ReviewRecordStatus.PENDING);
  }
}

class InMemoryAnnotationRepo {
  annotations: Annotation[] = [];
  verdicts: SectionVerdict[] = [];
  async putAnnotation(a: Annotation) { this.annotations.push(a); return a; }
  async deleteAnnotation() { /* no-op */ }
  async listAnnotations(d: string, r: string) {
    return this.annotations.filter((a) => a.documentId === d && a.reviewerId === r);
  }
  async putSectionVerdict(v: SectionVerdict) { this.verdicts.push(v); return v; }
  async listSectionVerdicts(d: string, r: string) {
    return this.verdicts.filter((v) => v.documentId === d && v.reviewerId === r);
  }
}

/** An in-memory queue sender that captures scheduling messages. */
class CapturingQueue {
  messages: SchedulingMessage[] = [];
  async send(body: unknown) { this.messages.push(body as SchedulingMessage); }
}

/** An S3-ish store returning fixed content and a presigned stub. */
function makeStore(content: string) {
  return {
    buildKey: (id: string) => `documents/${id}.md`,
    createUpload: async (id: string) => ({
      key: `documents/${id}.md`,
      url: 'https://s3.example/upload',
      fields: { key: `documents/${id}.md` },
    }),
    readContent: async () => content,
  };
}

const CONFIG = {
  defaultApprovalPolicy: 'all' as const,
  maxUploadSizeBytes: 5 * 1024 * 1024,
  aiConfidenceThreshold: 0.7,
  aiMaxAttempts: 3,
  schedulingWindowDays: 7,
  wordsPerMin: 200,
  minReviewMinutes: 15,
  maxReviewMinutes: 120,
};

function reviewer(id: string): AuthContext {
  return { userId: id, roles: [UserRole.REVIEWER] };
}

describe('E2E: upload → classify → schedule → review → approve', () => {
  let documentRepo: InMemoryDocumentRepo;
  let moduleRepo: InMemoryModuleRepo;
  let assignmentRepo: InMemoryAssignmentRepo;
  let reviewRecordRepo: InMemoryReviewRecordRepo;
  let annotationRepo: InMemoryAnnotationRepo;
  let events: FakeEventPublisher;
  let ai: FakeAiProvider;
  let calendar: FakeCalendarProvider;
  let queue: CapturingQueue;
  const store = makeStore('ventas content '.repeat(50));

  beforeEach(() => {
    documentRepo = new InMemoryDocumentRepo();
    moduleRepo = new InMemoryModuleRepo();
    assignmentRepo = new InMemoryAssignmentRepo();
    reviewRecordRepo = new InMemoryReviewRecordRepo();
    annotationRepo = new InMemoryAnnotationRepo();
    events = new FakeEventPublisher();
    ai = new FakeAiProvider();
    calendar = new FakeCalendarProvider();
    queue = new CapturingQueue();

    // Seed a module and two reviewers assigned with edit permission.
    moduleRepo.mods.set('m-ventas', { id: 'm-ventas', name: 'ventas', createdAt: 'now' });
    assignmentRepo.add({ reviewerId: 'u1', moduleId: 'm-ventas', permission: 'edit', createdAt: 'now' });
    assignmentRepo.add({ reviewerId: 'u2', moduleId: 'm-ventas', permission: 'edit', createdAt: 'now' });
  });

  it('runs the full happy path and approves under the "all" policy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docService = new DocumentService({ documentRepo, moduleRepo, documentStore: store, events, config: CONFIG } as any);

    // 1) Upload + confirm
    const init = await docService.initUpload('guia.md');
    const documentId = init.documentId;
    expect(init.uploadUrl).toBeTruthy();
    await docService.confirmUpload(documentId, 'admin-1');
    expect((await documentRepo.get(documentId))!.status).toBe(DocumentStatus.CLASSIFYING);

    // 2) Classification worker (S3 ObjectCreated → classify). FakeAiProvider
    //    matches the module whose name appears in the content ("ventas").
    const classificationService = new ClassificationService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moduleRepo: moduleRepo as any,
      documentStore: store,
      aiProvider: ai,
      events,
      config: CONFIG,
    });
    const s3Event = {
      Records: [{ eventSource: 'aws:s3', s3: { object: { key: `documents/${documentId}.md` } } }],
    } as unknown as S3Event;
    await runClassification(s3Event, { classificationService, schedulingQueue: queue });

    const classified = (await documentRepo.get(documentId))!;
    expect(classified.status).toBe(DocumentStatus.CLASSIFIED);
    expect(classified.moduleId).toBe('m-ventas');
    expect(queue.messages).toEqual([{ documentId }]);

    // 3) Scheduling worker (SQS → schedule). Creates one record per reviewer.
    const schedulingService = new SchedulingService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assignmentRepo: assignmentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewRecordRepo: reviewRecordRepo as any,
      documentStore: store,
      calendar,
      events,
      config: CONFIG,
    });
    const sqsEvent = {
      Records: queue.messages.map((m, i) => ({
        eventSource: 'aws:sqs',
        messageId: `m${i}`,
        body: JSON.stringify(m),
      })),
    } as unknown as SQSEvent;
    const batch = await runScheduling(sqsEvent, { schedulingService });
    expect(batch.batchItemFailures).toEqual([]);

    const records = await reviewRecordRepo.listForDocument(documentId);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.status === ReviewRecordStatus.PENDING)).toBe(true);

    // 4) Two reviewers work in parallel on their own records and submit.
    const approvalService = new ApprovalService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewRecordRepo: reviewRecordRepo as any,
      audit: new AuditService({ append: async () => {} }),
      events,
    });
    const reviewService = new ReviewRecordService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewRecordRepo: reviewRecordRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotationRepo: annotationRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assignmentRepo: assignmentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      events,
      approvalEvaluator: approvalService,
    });

    for (const uid of ['u1', 'u2']) {
      const id = `${documentId}#${uid}`;
      await reviewService.addAnnotation(reviewer(uid), id, { type: 'document' }, `review by ${uid}`);
      await reviewService.setSectionVerdict(reviewer(uid), id, 'intro', 'correct');
      await reviewService.setDocumentVerdict(reviewer(uid), id, 'correct');
    }

    // First submit completes one record; approval stays pending (not all done).
    await reviewService.submit(reviewer('u1'), `${documentId}#u1`);
    expect((await documentRepo.get(documentId))!.approvalStatus).toBeUndefined();

    // Second submit completes the set → approval evaluates to approved.
    await reviewService.submit(reviewer('u2'), `${documentId}#u2`);

    const finalDoc = (await documentRepo.get(documentId))!;
    expect(finalDoc.status).toBe(DocumentStatus.APPROVED);
    expect(finalDoc.approvalStatus).toBe('approved');
    expect(finalDoc.approvalDecidedAt).toBeDefined();

    // 5) Events emitted across the flow.
    const types = events.events.map((e) => e.type);
    expect(types).toContain(SystemEventType.DOCUMENT_UPLOADED);
    expect(types).toContain(SystemEventType.DOCUMENT_CLASSIFIED);
    expect(types).toContain(SystemEventType.REVIEW_SCHEDULED);
    expect(types).toContain(SystemEventType.REVIEW_RECORD_COMPLETED);
    expect(types).toContain(SystemEventType.DOCUMENT_APPROVED);
  });

  it('rejects under "all" when one reviewer marks the document incorrect', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docService = new DocumentService({ documentRepo, moduleRepo, documentStore: store, events, config: CONFIG } as any);
    const init = await docService.initUpload('guia.md');
    const documentId = init.documentId;
    await docService.confirmUpload(documentId, 'admin-1');

    // Shortcut: directly seed classification + records (flow covered above).
    const d = (await documentRepo.get(documentId))!;
    await documentRepo.update({ ...d, moduleId: 'm-ventas', status: DocumentStatus.CLASSIFIED });
    for (const uid of ['u1', 'u2']) {
      await reviewRecordRepo.put({
        documentId, reviewerId: uid, status: ReviewRecordStatus.PENDING,
        scheduled: { done: true }, createdAt: 'now',
      });
    }

    const approvalService = new ApprovalService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewRecordRepo: reviewRecordRepo as any,
      audit: new AuditService({ append: async () => {} }),
      events,
    });
    const reviewService = new ReviewRecordService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewRecordRepo: reviewRecordRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotationRepo: annotationRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assignmentRepo: assignmentRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentRepo: documentRepo as any,
      events,
      approvalEvaluator: approvalService,
    });

    await reviewService.setDocumentVerdict(reviewer('u1'), `${documentId}#u1`, 'correct');
    await reviewService.setDocumentVerdict(reviewer('u2'), `${documentId}#u2`, 'incorrect');
    await reviewService.submit(reviewer('u1'), `${documentId}#u1`);
    await reviewService.submit(reviewer('u2'), `${documentId}#u2`);

    const finalDoc = (await documentRepo.get(documentId))!;
    expect(finalDoc.status).toBe(DocumentStatus.REJECTED);
    expect(events.events.map((e) => e.type)).toContain(SystemEventType.DOCUMENT_REJECTED);
  });
});
