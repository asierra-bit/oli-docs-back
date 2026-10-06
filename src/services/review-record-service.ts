import { ulid } from 'ulid';
import type {
  Annotation,
  AnnotationTarget,
  ReviewRecord,
  SectionVerdict,
} from '../domain/entities.js';
import { Permission, ReviewRecordStatus, UserRole, type Verdict } from '../domain/enums.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { ReviewRecordRepo } from '../repositories/dynamo/review-record-repo.js';
import type { AnnotationRepo } from '../repositories/dynamo/annotation-repo.js';
import type { AssignmentRepo } from '../repositories/dynamo/assignment-repo.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { AuthContext } from '../handlers/auth/context.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';

/** A review record is addressed by the composite id `<documentId>#<reviewerId>`. */
export interface RecordRef {
  documentId: string;
  reviewerId: string;
}

export function parseRecordId(id: string): RecordRef {
  const idx = id.indexOf('#');
  if (idx <= 0 || idx === id.length - 1) {
    throw new ValidationError('Invalid review record id', [{ field: 'id', issue: 'format' }]);
  }
  return { documentId: id.slice(0, idx), reviewerId: id.slice(idx + 1) };
}

export function formatRecordId(ref: RecordRef): string {
  return `${ref.documentId}#${ref.reviewerId}`;
}

export interface ReviewRecordDetail {
  record: ReviewRecord;
  annotations: Annotation[];
  sectionVerdicts: SectionVerdict[];
}

/** Minimal surface of ApprovalService needed after a submit (R9.3). */
export interface ApprovalEvaluator {
  evaluate(documentId: string): Promise<unknown>;
}

export interface ReviewRecordServiceDeps {
  reviewRecordRepo: Pick<
    ReviewRecordRepo,
    'get' | 'put' | 'listForReviewer'
  >;
  annotationRepo: AnnotationRepo;
  assignmentRepo: Pick<AssignmentRepo, 'get'>;
  documentRepo: Pick<DocumentRepo, 'get'>;
  events: EventPublisher;
  /** Optional: triggers approval evaluation after a submit (R9.3). */
  approvalEvaluator?: ApprovalEvaluator;
}

/**
 * Review record operations (R7, R8). Each reviewer works only on their own
 * record (R7.4) and must hold `edit` permission on the document's module to
 * write annotations/verdicts (R8.4). Admins may reopen a completed record.
 */
export class ReviewRecordService {
  constructor(private readonly deps: ReviewRecordServiceDeps) {}

  /** Records belonging to the authenticated reviewer (R7.3). */
  async listMine(ctx: AuthContext): Promise<ReviewRecord[]> {
    return this.deps.reviewRecordRepo.listForReviewer(ctx.userId);
  }

  /** Fetch a record with its annotations and section verdicts (owner/admin). */
  async get(ctx: AuthContext, id: string): Promise<ReviewRecordDetail> {
    const ref = parseRecordId(id);
    const record = await this.loadOwnedRecord(ctx, ref);
    const [annotations, sectionVerdicts] = await Promise.all([
      this.deps.annotationRepo.listAnnotations(ref.documentId, ref.reviewerId),
      this.deps.annotationRepo.listSectionVerdicts(ref.documentId, ref.reviewerId),
    ]);
    return { record, annotations, sectionVerdicts };
  }

  async addAnnotation(
    ctx: AuthContext,
    id: string,
    target: AnnotationTarget,
    text: string,
  ): Promise<Annotation> {
    const ref = parseRecordId(id);
    const record = await this.loadWritableRecord(ctx, ref);
    this.ensureSectionTargetValid(target);

    const annotation: Annotation = {
      id: ulid(),
      documentId: record.documentId,
      reviewerId: record.reviewerId,
      target,
      text,
      createdAt: new Date().toISOString(),
    };
    return this.deps.annotationRepo.putAnnotation(annotation);
  }

  async setSectionVerdict(
    ctx: AuthContext,
    id: string,
    sectionId: string,
    verdict: Verdict,
  ): Promise<SectionVerdict> {
    const ref = parseRecordId(id);
    const record = await this.loadWritableRecord(ctx, ref);
    const sv: SectionVerdict = {
      documentId: record.documentId,
      reviewerId: record.reviewerId,
      sectionId,
      verdict,
    };
    return this.deps.annotationRepo.putSectionVerdict(sv);
  }

  async setDocumentVerdict(ctx: AuthContext, id: string, verdict: Verdict): Promise<ReviewRecord> {
    const ref = parseRecordId(id);
    const record = await this.loadWritableRecord(ctx, ref);
    const updated: ReviewRecord = { ...record, documentVerdict: verdict };
    return this.deps.reviewRecordRepo.put(updated);
  }

  /**
   * Submit a review record: requires a document-level verdict (R8.7),
   * transitions to `completed`, stamps submittedAt, and publishes
   * `review_record.completed` (R8.6, R13.1). Owner + edit permission required.
   */
  async submit(ctx: AuthContext, id: string): Promise<ReviewRecord> {
    const ref = parseRecordId(id);
    const record = await this.loadWritableRecord(ctx, ref);

    if (!record.documentVerdict) {
      throw new ValidationError('A document-level verdict is required before submitting', [
        { field: 'documentVerdict', issue: 'required' },
      ]);
    }

    const completed: ReviewRecord = {
      ...record,
      status: ReviewRecordStatus.COMPLETED,
      submittedAt: new Date().toISOString(),
    };
    await this.deps.reviewRecordRepo.put(completed);

    await this.deps.events.publish({
      type: SystemEventType.REVIEW_RECORD_COMPLETED,
      resourceId: ref.documentId,
      timestamp: new Date().toISOString(),
      actor: ctx.userId,
      detail: { reviewerId: ref.reviewerId, documentVerdict: completed.documentVerdict },
    });

    // Trigger approval evaluation; it decides only when all records are
    // completed (R9.3). Failures here must not fail the submit itself.
    if (this.deps.approvalEvaluator) {
      try {
        await this.deps.approvalEvaluator.evaluate(ref.documentId);
      } catch (err) {
        logger.error('Approval evaluation after submit failed', {
          documentId: ref.documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return completed;
  }

  /** Reopen a completed record back to `pending` (admin only, R8.8). */
  async reopen(ctx: AuthContext, id: string): Promise<ReviewRecord> {
    if (!ctx.roles.includes(UserRole.ADMIN)) {
      throw new ForbiddenError('Only an admin can reopen a review record');
    }
    const ref = parseRecordId(id);
    const record = await this.deps.reviewRecordRepo.get(ref.documentId, ref.reviewerId);
    if (!record) throw new NotFoundError('ReviewRecord', formatRecordId(ref));

    const reopened: ReviewRecord = {
      ...record,
      status: ReviewRecordStatus.PENDING,
      submittedAt: undefined,
    };
    return this.deps.reviewRecordRepo.put(reopened);
  }

  // --- helpers ---

  /** Load a record the caller owns (reviewer) or is admin for. */
  private async loadOwnedRecord(ctx: AuthContext, ref: RecordRef): Promise<ReviewRecord> {
    const record = await this.deps.reviewRecordRepo.get(ref.documentId, ref.reviewerId);
    if (!record) throw new NotFoundError('ReviewRecord', formatRecordId(ref));

    const isAdmin = ctx.roles.includes(UserRole.ADMIN);
    if (!isAdmin && ctx.userId !== ref.reviewerId) {
      throw new ForbiddenError("Cannot access another reviewer's record");
    }
    return record;
  }

  /**
   * Load a record for writing: owner-only, record must be `pending` (not
   * completed, R8.8), and the reviewer must hold `edit` permission on the
   * document's module (R8.4).
   */
  private async loadWritableRecord(ctx: AuthContext, ref: RecordRef): Promise<ReviewRecord> {
    const record = await this.loadOwnedRecord(ctx, ref);

    if (record.status === ReviewRecordStatus.COMPLETED) {
      throw new ConflictError('Review record is completed and cannot be modified');
    }

    // Admins do not author review content; writing requires an edit assignment.
    const doc = await this.deps.documentRepo.get(ref.documentId);
    if (!doc?.moduleId) {
      throw new ForbiddenError('Document is not assigned to a module');
    }
    const assignment = await this.deps.assignmentRepo.get(ctx.userId, doc.moduleId);
    if (!assignment || assignment.permission !== Permission.EDIT) {
      throw new ForbiddenError("Requires 'edit' permission on the module");
    }

    return record;
  }

  private ensureSectionTargetValid(target: AnnotationTarget): void {
    if (target.type === 'section' && !target.sectionId) {
      throw new ValidationError('sectionId is required for section annotations', [
        { field: 'target.sectionId', issue: 'required' },
      ]);
    }
  }
}
