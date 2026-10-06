import type { Document, ReviewRecord, ScheduleInfo } from '../domain/entities.js';
import { ReviewRecordStatus } from '../domain/enums.js';
import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { AppConfig } from '../lib/config.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { AssignmentRepo } from '../repositories/dynamo/assignment-repo.js';
import type { ReviewRecordRepo } from '../repositories/dynamo/review-record-repo.js';
import type { DocumentStore } from '../repositories/s3/document-store.js';
import type { CalendarProvider } from '../providers/calendar/types.js';
import { ScheduleReason } from '../providers/calendar/types.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';
import { estimateDurationMinutes, findFreeSlot } from './slot-finder.js';

export interface SchedulingServiceDeps {
  documentRepo: Pick<DocumentRepo, 'get'>;
  assignmentRepo: Pick<AssignmentRepo, 'listForModule'>;
  reviewRecordRepo: Pick<ReviewRecordRepo, 'put' | 'hasRecordsForDocument'>;
  documentStore: Pick<DocumentStore, 'readContent'>;
  calendar: CalendarProvider;
  events: EventPublisher;
  config: Pick<
    AppConfig,
    'schedulingWindowDays' | 'wordsPerMin' | 'minReviewMinutes' | 'maxReviewMinutes'
  >;
  now?: () => Date; // injectable clock for tests
}

/**
 * Resolves the reviewers of a classified document's module and creates one
 * independent, parallel review record per reviewer, scheduling a calendar
 * block for each (R6, R7.1).
 */
export class SchedulingService {
  constructor(private readonly deps: SchedulingServiceDeps) {}

  async scheduleFor(documentId: string): Promise<ReviewRecord[]> {
    const doc = await this.deps.documentRepo.get(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);
    if (!doc.moduleId) {
      throw new NotFoundError('Module for document', documentId);
    }

    // Dedup: if this document was already scheduled (records exist), do nothing.
    // SQS has at-least-once delivery, so a redelivered message must not create
    // duplicate records or re-publish review.scheduled events.
    if (await this.deps.reviewRecordRepo.hasRecordsForDocument(documentId)) {
      logger.info('Scheduling skipped: document already has review records', { documentId });
      return [];
    }

    const assignments = await this.deps.assignmentRepo.listForModule(doc.moduleId);
    if (assignments.length === 0) {
      logger.info('No reviewers assigned to module; nothing to schedule', {
        documentId,
        moduleId: doc.moduleId,
      });
      return [];
    }

    const durationMinutes = await this.estimateDuration(doc);
    const now = this.deps.now ? this.deps.now() : new Date();
    const windowEnd = new Date(now.getTime() + this.deps.config.schedulingWindowDays * 86_400_000);

    const records: ReviewRecord[] = [];
    for (const assignment of assignments) {
      const scheduled = await this.scheduleForReviewer(
        doc,
        assignment.reviewerId,
        durationMinutes,
        now,
        windowEnd,
      );

      const record: ReviewRecord = {
        documentId,
        reviewerId: assignment.reviewerId,
        status: ReviewRecordStatus.PENDING,
        scheduled,
        createdAt: new Date().toISOString(),
      };
      await this.deps.reviewRecordRepo.put(record);
      records.push(record);

      await this.deps.events.publish({
        type: SystemEventType.REVIEW_SCHEDULED,
        resourceId: documentId,
        timestamp: new Date().toISOString(),
        detail: {
          reviewerId: assignment.reviewerId,
          scheduled: scheduled.done,
          reason: scheduled.reason,
        },
      });
    }

    return records;
  }

  /** Compute the per-reviewer schedule outcome without blocking the flow. */
  private async scheduleForReviewer(
    doc: Document,
    reviewerId: string,
    durationMinutes: number,
    from: Date,
    to: Date,
  ): Promise<ScheduleInfo> {
    const busy = await this.deps.calendar.getBusy({
      reviewerId,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const slot = findFreeSlot(from, to, durationMinutes, busy);
    if (!slot) {
      return { done: false, reason: ScheduleReason.NO_FREE_SLOT };
    }

    const result = await this.deps.calendar.schedule({
      reviewerId,
      slot,
      summary: `Review: ${doc.name}`,
      description: `Please review document ${doc.id}.`,
    });

    if (result.scheduled) {
      return { done: true, eventId: result.externalEventId, slot };
    }
    // Soft failure (not authorized / API error): record but do not block (R6.5/6.6).
    return { done: false, reason: result.reason, slot };
  }

  private async estimateDuration(doc: Document): Promise<number> {
    let wordCount = 0;
    try {
      const content = await this.deps.documentStore.readContent(doc.s3Key);
      wordCount = content.trim().split(/\s+/).filter(Boolean).length;
    } catch (err) {
      logger.warn('Could not read content for duration estimate; using minimum', {
        documentId: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return estimateDurationMinutes(wordCount, {
      wordsPerMin: this.deps.config.wordsPerMin,
      min: this.deps.config.minReviewMinutes,
      max: this.deps.config.maxReviewMinutes,
    });
  }
}
