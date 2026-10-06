import type { S3Event, SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DocumentStatus } from '../../domain/enums.js';
import { logger } from '../../lib/logger.js';
import type { ClassificationService } from '../../services/classification-service.js';
import type { QueueSender, SchedulingMessage } from '../../repositories/sqs/queue-sender.js';
import { DocumentStore } from '../../repositories/s3/document-store.js';

export interface ClassificationWorkerDeps {
  classificationService: Pick<ClassificationService, 'classify'>;
  schedulingQueue: QueueSender;
}

type WorkerEvent = S3Event | SQSEvent;

/** A document to classify, paired with the SQS message id that produced it. */
interface WorkItem {
  documentId: string;
  /** Present only for SQS-triggered items — used for partial batch failures. */
  messageId?: string;
}

/** Discriminate S3 vs SQS by the shape of the first record. */
function isSqsEvent(event: WorkerEvent): event is SQSEvent {
  const first = (event as SQSEvent).Records?.[0] as { eventSource?: string } | undefined;
  return first?.eventSource === 'aws:sqs';
}

/**
 * Extract work items to classify from either trigger:
 *  - S3 `ObjectCreated`: key `documents/<docId>.md` (R4.5)
 *  - SQS retry message: JSON `{ documentId }` (carries the messageId so a
 *    failure can be reported as a partial batch failure)
 */
export function extractWorkItems(event: WorkerEvent): WorkItem[] {
  const items: WorkItem[] = [];

  if (isSqsEvent(event)) {
    for (const record of event.Records) {
      try {
        const body = JSON.parse(record.body) as { documentId?: string };
        if (body.documentId) {
          items.push({ documentId: body.documentId, messageId: record.messageId });
        }
      } catch {
        logger.warn('Skipping unparseable SQS message', { messageId: record.messageId });
      }
    }
    return items;
  }

  for (const record of event.Records) {
    const key = record.s3?.object?.key;
    if (!key) continue;
    const docId = DocumentStore.parseDocId(key);
    if (docId) {
      items.push({ documentId: docId });
    } else {
      logger.warn('S3 key did not match a document content key', { key });
    }
  }
  return items;
}

/** Back-compat helper: just the document ids (used by some tests). */
export function extractDocumentIds(event: WorkerEvent): string[] {
  return extractWorkItems(event).map((i) => i.documentId);
}

/**
 * Core worker logic (testable): classify each document and, when it becomes
 * `classified`, enqueue a scheduling message (R5.1, R5.2, R6.1). Low-confidence
 * and failed outcomes are terminal and do not enqueue scheduling.
 *
 * Each work item is isolated in its own try/catch so one failing document does
 * NOT abort the others. For SQS-sourced items a failure is returned as a
 * partial batch failure (`batchItemFailures`) so only that message is retried
 * — this requires `ReportBatchItemFailures` on the event source mapping. Items
 * without a messageId (S3-triggered) cannot be partially retried; their failure
 * is logged and, by rethrowing when the whole batch is S3-only and everything
 * failed, we let Lambda's own retry handle it.
 */
export async function runClassification(
  event: WorkerEvent,
  deps: ClassificationWorkerDeps,
): Promise<SQSBatchResponse> {
  const items = extractWorkItems(event);
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const item of items) {
    try {
      const outcome = await deps.classificationService.classify(item.documentId);

      // Only enqueue scheduling when THIS call freshly classified the document.
      // A redelivered/retried message for an already-classified doc returns
      // classifiedNow=false, so we don't produce duplicate scheduling messages.
      if (outcome.status === DocumentStatus.CLASSIFIED && outcome.classifiedNow) {
        const message: SchedulingMessage = { documentId: item.documentId };
        await deps.schedulingQueue.send(message);
        logger.info('Enqueued scheduling after classification', {
          documentId: item.documentId,
        });
      } else {
        logger.info('Classification did not produce a classified document', {
          documentId: item.documentId,
          status: outcome.status,
        });
      }
    } catch (err) {
      logger.error('Classification work item failed', {
        documentId: item.documentId,
        messageId: item.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (item.messageId) {
        // SQS: retry only this message.
        batchItemFailures.push({ itemIdentifier: item.messageId });
      } else {
        // S3-triggered: no per-item retry channel. Rethrow so Lambda retries
        // the (S3) invocation rather than silently dropping the document.
        throw err;
      }
    }
  }

  return { batchItemFailures };
}
