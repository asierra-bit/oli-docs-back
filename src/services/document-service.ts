import { ulid } from 'ulid';
import type { Document } from '../domain/entities.js';
import { DocumentStatus, ClassificationSource, type ApprovalPolicy } from '../domain/enums.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { AppConfig } from '../lib/config.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { ModuleRepo } from '../repositories/dynamo/module-repo.js';
import type { DocumentStore } from '../repositories/s3/document-store.js';
import type { EventPublisher } from '../events/publisher.js';
import { SystemEventType } from '../events/types.js';

export interface InitUploadResult {
  documentId: string;
  name: string;
  uploadUrl: string;
  uploadFields: Record<string, string>;
}

export interface DocumentServiceDeps {
  documentRepo: DocumentRepo;
  moduleRepo: Pick<ModuleRepo, 'get'>;
  documentStore: Pick<DocumentStore, 'createUpload' | 'buildKey'>;
  events: EventPublisher;
  config: Pick<AppConfig, 'defaultApprovalPolicy' | 'maxUploadSizeBytes'>;
}

/**
 * Business logic for documents (R4). Handles upload initiation, upload
 * confirmation, retrieval, manual reclassification and approval-policy config.
 */
export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  /**
   * Create document metadata in `pending_content` and return a presigned POST
   * for the client to upload the `.md` content directly to S3 (R4.1, R4.3).
   * The default approval policy is applied (R9.2). Filename/size validation
   * happens at the handler (zod + S3 content-length-range).
   */
  async initUpload(name: string): Promise<InitUploadResult> {
    const documentId = ulid();
    const key = this.deps.documentStore.buildKey(documentId);
    const now = new Date().toISOString();

    const doc: Document = {
      id: documentId,
      name,
      s3Key: key,
      status: DocumentStatus.PENDING_CONTENT,
      approvalPolicy: this.deps.config.defaultApprovalPolicy,
      createdAt: now,
    };
    await this.deps.documentRepo.put(doc);

    const upload = await this.deps.documentStore.createUpload(documentId, {
      maxBytes: this.deps.config.maxUploadSizeBytes,
    });

    return {
      documentId,
      name,
      uploadUrl: upload.url,
      uploadFields: upload.fields,
    };
  }

  /**
   * Confirm that content landed in S3 and advance the document out of
   * `pending_content` so classification can start (R4.6). Idempotent: a second
   * confirm for an already-confirmed document is a no-op that does not
   * re-publish the event.
   */
  async confirmUpload(documentId: string, actor?: string): Promise<Document> {
    const doc = await this.getOrThrow(documentId);

    // Idempotency: only transition from pending_content.
    if (doc.status !== DocumentStatus.PENDING_CONTENT) {
      return doc;
    }

    const updated: Document = {
      ...doc,
      status: DocumentStatus.CLASSIFYING,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.documentRepo.update(updated);

    await this.deps.events.publish({
      type: SystemEventType.DOCUMENT_UPLOADED,
      resourceId: documentId,
      timestamp: new Date().toISOString(),
      actor,
      detail: { name: doc.name, s3Key: doc.s3Key },
    });

    return updated;
  }

  async get(documentId: string): Promise<Document> {
    return this.getOrThrow(documentId);
  }

  async list(): Promise<Document[]> {
    return this.deps.documentRepo.list();
  }

  /**
   * Manually reassign a document's module, overriding the AI classification
   * and marking the source as manual (R5.6).
   */
  async reassignModule(documentId: string, moduleId: string): Promise<Document> {
    const doc = await this.getOrThrow(documentId);
    const module = await this.deps.moduleRepo.get(moduleId);
    if (!module) {
      throw new NotFoundError('Module', moduleId);
    }

    const updated: Document = {
      ...doc,
      moduleId,
      classification: { source: ClassificationSource.MANUAL },
      status: DocumentStatus.CLASSIFIED,
      updatedAt: new Date().toISOString(),
    };
    return this.deps.documentRepo.update(updated);
  }

  /** Set the approval policy for a document (R9.1). */
  async setApprovalPolicy(documentId: string, policy: ApprovalPolicy): Promise<Document> {
    const doc = await this.getOrThrow(documentId);
    if (
      doc.status === DocumentStatus.APPROVED ||
      doc.status === DocumentStatus.REJECTED
    ) {
      throw new ConflictError('Cannot change approval policy after a decision was reached');
    }
    const updated: Document = {
      ...doc,
      approvalPolicy: policy,
      updatedAt: new Date().toISOString(),
    };
    return this.deps.documentRepo.update(updated);
  }

  private async getOrThrow(documentId: string): Promise<Document> {
    const doc = await this.deps.documentRepo.get(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);
    return doc;
  }
}
