import type { Document } from '../domain/entities.js';
import { ClassificationSource, DocumentStatus } from '../domain/enums.js';
import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { AppConfig } from '../lib/config.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { ModuleRepo } from '../repositories/dynamo/module-repo.js';
import type { DocumentStore } from '../repositories/s3/document-store.js';
import type { AiProvider } from '../providers/ai/types.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';

export interface ClassificationServiceDeps {
  documentRepo: Pick<DocumentRepo, 'get' | 'update'>;
  moduleRepo: Pick<ModuleRepo, 'list'>;
  documentStore: Pick<DocumentStore, 'readContent'>;
  aiProvider: AiProvider;
  events: EventPublisher;
  config: Pick<AppConfig, 'aiConfidenceThreshold' | 'aiMaxAttempts'>;
}

export interface ClassificationOutcome {
  status: DocumentStatus;
  moduleId?: string;
  confidence?: number;
  /**
   * True only when THIS call transitioned the document into `classified`.
   * False when the document was already classified (idempotent re-delivery),
   * so the worker can avoid re-enqueuing scheduling.
   */
  classifiedNow?: boolean;
}

/**
 * Classifies a document's module via the configured AiProvider (R5).
 *
 * Outcomes:
 *  - confidence ≥ threshold → status `classified`, module set, source `ai`.
 *  - confidence < threshold → status `needs_manual_classification` (R5.3).
 *  - provider fails after all retries → status `classification_failed` (R5.7).
 * Publishes a corresponding system event (R13.1) and never throws for a
 * low-confidence or failed classification — those are terminal states, not
 * errors, so the worker does not retry them via the queue.
 */
export class ClassificationService {
  constructor(private readonly deps: ClassificationServiceDeps) {}

  async classify(documentId: string): Promise<ClassificationOutcome> {
    const doc = await this.deps.documentRepo.get(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);

    // Idempotency: the worker is triggered by both S3 ObjectCreated and SQS
    // retries, and a partial batch retry can redeliver an already-processed
    // document. Skip documents already classified or already parked for manual
    // review so we don't re-publish events or re-enqueue scheduling (R5). A
    // `classification_failed` doc is allowed through so a manual/queued retry
    // can recover it.
    if (
      doc.status === DocumentStatus.CLASSIFIED ||
      doc.status === DocumentStatus.NEEDS_MANUAL_CLASSIFICATION
    ) {
      logger.info('Skipping already-processed document', {
        documentId,
        status: doc.status,
      });
      return {
        status: doc.status,
        moduleId: doc.moduleId,
        confidence: doc.classification?.confidence,
        classifiedNow: false,
      };
    }

    const [content, modules] = await Promise.all([
      this.deps.documentStore.readContent(doc.s3Key),
      this.deps.moduleRepo.list(),
    ]);

    const result = await this.classifyWithRetries(documentId, {
      content,
      modules: modules.map((m) => ({ id: m.id, name: m.name })),
    });

    // Provider exhausted retries → classification_failed (R5.7).
    if (result === null) {
      await this.updateStatus(doc, DocumentStatus.CLASSIFICATION_FAILED);
      return { status: DocumentStatus.CLASSIFICATION_FAILED };
    }

    const confident =
      result.moduleId !== null && result.confidence >= this.deps.config.aiConfidenceThreshold;

    if (!confident) {
      await this.updateStatus(doc, DocumentStatus.NEEDS_MANUAL_CLASSIFICATION);
      await this.deps.events.publish({
        type: SystemEventType.DOCUMENT_NEEDS_MANUAL_CLASSIFICATION,
        resourceId: documentId,
        timestamp: new Date().toISOString(),
        detail: { confidence: result.confidence },
      });
      return { status: DocumentStatus.NEEDS_MANUAL_CLASSIFICATION, confidence: result.confidence };
    }

    const updated: Document = {
      ...doc,
      moduleId: result.moduleId!,
      classification: { source: ClassificationSource.AI, confidence: result.confidence },
      status: DocumentStatus.CLASSIFIED,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.documentRepo.update(updated);

    await this.deps.events.publish({
      type: SystemEventType.DOCUMENT_CLASSIFIED,
      resourceId: documentId,
      timestamp: new Date().toISOString(),
      detail: { moduleId: result.moduleId, confidence: result.confidence },
    });

    return {
      status: DocumentStatus.CLASSIFIED,
      moduleId: result.moduleId!,
      confidence: result.confidence,
      classifiedNow: true,
    };
  }

  /** Call the provider with bounded retries; returns null if all attempts fail. */
  private async classifyWithRetries(
    documentId: string,
    input: Parameters<AiProvider['classifyDocument']>[0],
  ) {
    const maxAttempts = Math.max(1, this.deps.config.aiMaxAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.deps.aiProvider.classifyDocument(input);
      } catch (err) {
        lastError = err;
        logger.warn('AI classification attempt failed', {
          documentId,
          attempt,
          maxAttempts,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.error('AI classification failed after all retries', {
      documentId,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return null;
  }

  private async updateStatus(doc: Document, status: DocumentStatus): Promise<void> {
    await this.deps.documentRepo.update({
      ...doc,
      status,
      updatedAt: new Date().toISOString(),
    });
  }
}
