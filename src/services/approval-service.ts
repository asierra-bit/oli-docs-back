import type { Document, ExcludedRecord, ReviewRecord } from '../domain/entities.js';
import {
  ApprovalPolicy,
  DocumentStatus,
  ReviewRecordStatus,
  Verdict,
} from '../domain/enums.js';
import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { ReviewRecordRepo } from '../repositories/dynamo/review-record-repo.js';
import type { AuditService } from './audit-service.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';

export interface ApprovalServiceDeps {
  documentRepo: Pick<DocumentRepo, 'get' | 'update'>;
  reviewRecordRepo: Pick<ReviewRecordRepo, 'listForDocument'>;
  audit: Pick<AuditService, 'record'>;
  events: EventPublisher;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'pending';

export interface EvaluateResult {
  decision: ApprovalDecision;
  document: Document;
}

/**
 * Determines a document's final approval status from its review records (R9).
 */
export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Evaluate after a submit (R9.3). Only decides once every review record is
   * `completed`; otherwise leaves the document unchanged and returns `pending`.
   */
  async evaluate(documentId: string): Promise<EvaluateResult> {
    const doc = await this.getDoc(documentId);
    const records = await this.deps.reviewRecordRepo.listForDocument(documentId);

    if (records.length === 0 || records.some((r) => r.status !== ReviewRecordStatus.COMPLETED)) {
      return { decision: 'pending', document: doc };
    }

    return this.decide(doc, records, { actor: 'system' });
  }

  /**
   * Admin forces evaluation excluding records that never got submitted (R9.9).
   * Records whose reviewerId is in `excludedRecordIds` are dropped from the
   * tally; the exclusions and reason are persisted on the document and audited.
   */
  async forceEvaluate(
    documentId: string,
    excludedReviewerIds: string[],
    reason: string,
    actor: string,
  ): Promise<EvaluateResult> {
    const doc = await this.getDoc(documentId);
    const records = await this.deps.reviewRecordRepo.listForDocument(documentId);

    const excluded = new Set(excludedReviewerIds);
    const counted = records.filter((r) => !excluded.has(r.reviewerId));

    const excludedRecords: ExcludedRecord[] = records
      .filter((r) => excluded.has(r.reviewerId))
      .map((r) => ({ reviewerId: r.reviewerId, reason }));

    await this.deps.audit.record({
      actor,
      action: 'force_approval',
      target: `DOC#${documentId}`,
      details: { excludedReviewerIds, reason },
    });

    return this.decide(doc, counted, { actor, excludedRecords });
  }

  /** Core policy application shared by evaluate and forceEvaluate. */
  private async decide(
    doc: Document,
    records: ReviewRecord[],
    opts: { actor: string; excludedRecords?: ExcludedRecord[] },
  ): Promise<EvaluateResult> {
    const verdicts = records.map((r) => r.documentVerdict).filter((v): v is Verdict => Boolean(v));
    const decision = this.applyPolicy(doc.approvalPolicy, verdicts);

    const status =
      decision === 'approved' ? DocumentStatus.APPROVED : DocumentStatus.REJECTED;

    const updated: Document = {
      ...doc,
      status,
      approvalStatus: decision,
      approvalDecidedAt: new Date().toISOString(),
      ...(opts.excludedRecords && opts.excludedRecords.length > 0
        ? { excludedRecords: opts.excludedRecords }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.deps.documentRepo.update(updated);

    await this.deps.audit.record({
      actor: opts.actor,
      action: 'approval_decided',
      target: `DOC#${doc.id}`,
      details: { decision, policy: doc.approvalPolicy },
    });

    await this.deps.events.publish({
      type:
        decision === 'approved'
          ? SystemEventType.DOCUMENT_APPROVED
          : SystemEventType.DOCUMENT_REJECTED,
      resourceId: doc.id,
      timestamp: new Date().toISOString(),
      actor: opts.actor,
      detail: { policy: doc.approvalPolicy },
    });

    logger.info('Approval decided', { documentId: doc.id, decision, policy: doc.approvalPolicy });
    return { decision, document: saved };
  }

  /**
   * Apply the approval policy to the document-level verdicts (R9.4–9.7).
   *  - all: approved iff every verdict is correct; rejected if any incorrect.
   *  - any: approved if at least one correct; rejected if all incorrect.
   * With no verdicts (all excluded), fall back to rejected — nothing approved it.
   */
  private applyPolicy(policy: Document['approvalPolicy'], verdicts: Verdict[]): 'approved' | 'rejected' {
    if (verdicts.length === 0) return 'rejected';

    if (policy === ApprovalPolicy.ALL) {
      return verdicts.every((v) => v === Verdict.CORRECT) ? 'approved' : 'rejected';
    }
    // ANY
    return verdicts.some((v) => v === Verdict.CORRECT) ? 'approved' : 'rejected';
  }

  private async getDoc(documentId: string): Promise<Document> {
    const doc = await this.deps.documentRepo.get(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);
    return doc;
  }
}
