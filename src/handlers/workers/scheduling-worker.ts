import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logger } from '../../lib/logger.js';
import type { SchedulingService } from '../../services/scheduling-service.js';

export interface SchedulingWorkerDeps {
  schedulingService: Pick<SchedulingService, 'scheduleFor'>;
}

/**
 * Core logic (testable): process each SQS record, invoking SchedulingService
 * per documentId. Returns `batchItemFailures` for messages that threw, so with
 * `ReportBatchItemFailures` enabled on the event source mapping only the failed
 * messages are retried (and eventually DLQ'd) — successful ones are not
 * reprocessed. Scheduling itself is deduped per document, so a redelivery is a
 * safe no-op.
 */
export async function runScheduling(
  event: SQSEvent,
  deps: SchedulingWorkerDeps,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let documentId: string | undefined;
    try {
      documentId = (JSON.parse(record.body) as { documentId?: string }).documentId;
    } catch {
      // A permanently malformed message would loop forever if we retried it;
      // log and drop it (do not add to failures).
      logger.warn('Dropping unparseable scheduling message', { messageId: record.messageId });
      continue;
    }

    if (!documentId) {
      logger.warn('Scheduling message missing documentId; dropping', {
        messageId: record.messageId,
      });
      continue;
    }

    try {
      await deps.schedulingService.scheduleFor(documentId);
    } catch (err) {
      logger.error('Scheduling failed; message will be retried', {
        messageId: record.messageId,
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
