import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getConfig } from '../../lib/config.js';
import {
  validate,
  createAnnotationSchema,
  documentVerdictSchema,
  sectionVerdictSchema,
} from '../../lib/validation.js';
import { NotFoundError } from '../../lib/errors.js';
import { createDocumentClient } from '../../repositories/dynamo/client.js';
import { ReviewRecordRepo } from '../../repositories/dynamo/review-record-repo.js';
import { AnnotationRepo } from '../../repositories/dynamo/annotation-repo.js';
import { AssignmentRepo } from '../../repositories/dynamo/assignment-repo.js';
import { DocumentRepo } from '../../repositories/dynamo/document-repo.js';
import { AuditRepo } from '../../repositories/dynamo/audit-repo.js';
import { EventBridgePublisher } from '../../events/publisher.js';
import { ReviewRecordService } from '../../services/review-record-service.js';
import { ApprovalService } from '../../services/approval-service.js';
import { AuditService } from '../../services/audit-service.js';
import { getAuthContext } from '../auth/context.js';
import { requireAuth } from '../auth/guards.js';
import { ok, created, errorResponse, parseJsonBody } from './response.js';

export interface ReviewRecordHandlerDeps {
  service: ReviewRecordService;
}

let cached: ReviewRecordHandlerDeps | null = null;

function getDeps(): ReviewRecordHandlerDeps {
  if (cached) return cached;
  const cfg = getConfig();
  const client = createDocumentClient();
  const reviewRecordRepo = new ReviewRecordRepo(client, cfg.tableName);
  const documentRepo = new DocumentRepo(client, cfg.tableName);
  const events = new EventBridgePublisher(cfg.region);
  const audit = new AuditService(new AuditRepo(client, cfg.tableName));

  const approvalEvaluator = new ApprovalService({
    documentRepo,
    reviewRecordRepo,
    audit,
    events,
  });

  cached = {
    service: new ReviewRecordService({
      reviewRecordRepo,
      annotationRepo: new AnnotationRepo(client, cfg.tableName),
      assignmentRepo: new AssignmentRepo(client, cfg.tableName),
      documentRepo,
      events,
      approvalEvaluator,
    }),
  };
  return cached;
}

/** For tests: inject deps and reset the cache. */
export function __setDeps(deps: ReviewRecordHandlerDeps | null): void {
  cached = deps;
}

/**
 * Routes:
 *   GET  /v1/reviews/mine                                   (R7.3)
 *   GET  /v1/review-records/{id}
 *   POST /v1/review-records/{id}/annotations
 *   PUT  /v1/review-records/{id}/sections/{sectionId}/verdict
 *   PUT  /v1/review-records/{id}/document-verdict
 *   POST /v1/review-records/{id}/submit                     (R8.6)
 *   POST /v1/review-records/{id}/reopen                     (admin, R8.8)
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const ctx = getAuthContext(event);
    requireAuth(ctx);

    const { service } = getDeps();
    const method = event.requestContext.http.method;
    const path = event.requestContext.http.path;
    const id = event.pathParameters?.id;
    const sectionId = event.pathParameters?.sectionId;

    // GET /v1/reviews/mine
    if (method === 'GET' && path.endsWith('/reviews/mine')) {
      return ok(await service.listMine(ctx));
    }

    if (!id) {
      return errorResponse(new NotFoundError('Route', `${method} ${path}`));
    }

    if (method === 'POST' && path.endsWith('/annotations')) {
      const input = validate(createAnnotationSchema, parseJsonBody(event.body));
      return created(await service.addAnnotation(ctx, id, input.target, input.text));
    }

    if (method === 'PUT' && path.endsWith('/verdict') && sectionId) {
      const input = validate(sectionVerdictSchema, parseJsonBody(event.body));
      return ok(await service.setSectionVerdict(ctx, id, sectionId, input.verdict));
    }

    if (method === 'PUT' && path.endsWith('/document-verdict')) {
      const input = validate(documentVerdictSchema, parseJsonBody(event.body));
      return ok(await service.setDocumentVerdict(ctx, id, input.verdict));
    }

    if (method === 'POST' && path.endsWith('/submit')) {
      return ok(await service.submit(ctx, id));
    }

    if (method === 'POST' && path.endsWith('/reopen')) {
      return ok(await service.reopen(ctx, id));
    }

    if (method === 'GET') {
      return ok(await service.get(ctx, id));
    }

    return errorResponse(new NotFoundError('Route', `${method} ${path}`));
  } catch (err) {
    return errorResponse(err);
  }
}
