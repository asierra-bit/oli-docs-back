import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getConfig } from '../../lib/config.js';
import {
  validate,
  initUploadSchema,
  initUploadBatchSchema,
  reassignModuleSchema,
  setApprovalPolicySchema,
  forceApprovalSchema,
} from '../../lib/validation.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { UserRole } from '../../domain/enums.js';
import { createDocumentClient } from '../../repositories/dynamo/client.js';
import { DocumentRepo } from '../../repositories/dynamo/document-repo.js';
import { ModuleRepo } from '../../repositories/dynamo/module-repo.js';
import { AuditRepo } from '../../repositories/dynamo/audit-repo.js';
import { ReviewRecordRepo } from '../../repositories/dynamo/review-record-repo.js';
import { DocumentStore } from '../../repositories/s3/document-store.js';
import { EventBridgePublisher } from '../../events/publisher.js';
import { DocumentService } from '../../services/document-service.js';
import { AuditService } from '../../services/audit-service.js';
import { ApprovalService } from '../../services/approval-service.js';
import { getAuthContext } from '../auth/context.js';
import { requireRole } from '../auth/guards.js';
import { ok, created, errorResponse, parseJsonBody } from './response.js';

export interface DocumentHandlerDeps {
  documentService: DocumentService;
  approvalService: ApprovalService;
  audit: AuditService;
}

let cached: DocumentHandlerDeps | null = null;

function getDeps(): DocumentHandlerDeps {
  if (cached) return cached;
  const cfg = getConfig();
  const client = createDocumentClient();
  const documentRepo = new DocumentRepo(client, cfg.tableName);
  const moduleRepo = new ModuleRepo(client, cfg.tableName);
  const reviewRecordRepo = new ReviewRecordRepo(client, cfg.tableName);
  const auditRepo = new AuditRepo(client, cfg.tableName);
  const documentStore = new DocumentStore(cfg.bucketName, { region: cfg.region });
  const events = new EventBridgePublisher(cfg.region);
  const audit = new AuditService(auditRepo);

  cached = {
    documentService: new DocumentService({
      documentRepo,
      moduleRepo,
      documentStore,
      events,
      config: cfg,
    }),
    approvalService: new ApprovalService({ documentRepo, reviewRecordRepo, audit, events }),
    audit,
  };
  return cached;
}

/** For tests: inject deps and reset the cache. */
export function __setDeps(deps: DocumentHandlerDeps | null): void {
  cached = deps;
}

/**
 * Routes:
 *   POST  /v1/documents                        → init upload (single or batch)
 *   POST  /v1/documents/{id}/confirm-upload     → confirm content landed
 *   GET   /v1/documents                         → list
 *   GET   /v1/documents/{id}                     → get one
 *   PATCH /v1/documents/{id}/module              → manual reclassification (R5.6)
 *   PATCH /v1/documents/{id}/approval-policy      → set approval policy (R9.1)
 *
 * All require the 'admin' role.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const ctx = getAuthContext(event);
    requireRole(ctx, UserRole.ADMIN);

    const { documentService, approvalService, audit } = getDeps();
    const method = event.requestContext.http.method;
    const path = event.requestContext.http.path;
    const documentId = event.pathParameters?.id;

    // --- Sub-resource routes on a specific document ---
    if (documentId) {
      if (method === 'POST' && path.endsWith('/confirm-upload')) {
        const doc = await documentService.confirmUpload(documentId, ctx.userId);
        return ok(doc);
      }
      if (method === 'POST' && path.endsWith('/force-approval')) {
        const input = validate(forceApprovalSchema, parseJsonBody(event.body));
        const result = await approvalService.forceEvaluate(
          documentId,
          input.excludedRecordIds,
          input.reason,
          ctx.userId,
        );
        return ok({ decision: result.decision, document: result.document });
      }
      if (method === 'PATCH' && path.endsWith('/module')) {
        const input = validate(reassignModuleSchema, parseJsonBody(event.body));
        const doc = await documentService.reassignModule(documentId, input.moduleId);
        await audit.record({
          actor: ctx.userId,
          action: 'reassign_document_module',
          target: `DOC#${documentId}`,
          details: { moduleId: input.moduleId },
        });
        return ok(doc);
      }
      if (method === 'PATCH' && path.endsWith('/approval-policy')) {
        const input = validate(setApprovalPolicySchema, parseJsonBody(event.body));
        const doc = await documentService.setApprovalPolicy(documentId, input.approvalPolicy);
        await audit.record({
          actor: ctx.userId,
          action: 'set_approval_policy',
          target: `DOC#${documentId}`,
          details: { approvalPolicy: input.approvalPolicy },
        });
        return ok(doc);
      }
      if (method === 'GET') {
        return ok(await documentService.get(documentId));
      }
      return errorResponse(new NotFoundError('Route', `${method} ${path}`));
    }

    // --- Collection routes ---
    switch (method) {
      case 'POST':
        return created(await handleInit(event, documentService));
      case 'GET':
        return ok(await documentService.list());
      default:
        return errorResponse(new NotFoundError('Route', method));
    }
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Init upload supporting a single document or a batch. A batch request
 * ({ files: [...] }) processes each file individually and reports a per-file
 * result (R4.4): success entries carry the upload target, failures carry the
 * validation error — the batch itself still returns 201.
 */
async function handleInit(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  service: DocumentService,
): Promise<unknown> {
  const body = parseJsonBody(event.body) as Record<string, unknown>;

  // Batch form: { files: [{ name }, ...] }
  if (Array.isArray(body.files)) {
    const { files } = validate(initUploadBatchSchema, body);
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          const r = await service.initUpload(f.name);
          return { status: 'ok' as const, ...r };
        } catch (err) {
          const message = err instanceof ValidationError ? err.message : 'Failed to init upload';
          return { name: f.name, status: 'error' as const, error: message };
        }
      }),
    );
    return { results };
  }

  // Single form: { name }
  const input = validate(initUploadSchema, body);
  return service.initUpload(input.name);
}
