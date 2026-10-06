import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getConfig } from '../../lib/config.js';
import {
  validate,
  createReviewerSchema,
  createAssignmentSchema,
  updateAssignmentSchema,
} from '../../lib/validation.js';
import { NotFoundError } from '../../lib/errors.js';
import { UserRole } from '../../domain/enums.js';
import { createDocumentClient } from '../../repositories/dynamo/client.js';
import { ReviewerRepo } from '../../repositories/dynamo/reviewer-repo.js';
import { ModuleRepo } from '../../repositories/dynamo/module-repo.js';
import { AssignmentRepo } from '../../repositories/dynamo/assignment-repo.js';
import { AuditRepo } from '../../repositories/dynamo/audit-repo.js';
import { CognitoAdminClient } from '../../providers/cognito/cognito-admin.js';
import { ReviewerService } from '../../services/reviewer-service.js';
import { AssignmentService } from '../../services/assignment-service.js';
import { AuditService } from '../../services/audit-service.js';
import { getAuthContext } from '../auth/context.js';
import { requireRole } from '../auth/guards.js';
import { ok, created, noContent, errorResponse, parseJsonBody } from './response.js';

export interface ReviewerHandlerDeps {
  reviewerService: ReviewerService;
  assignmentService: AssignmentService;
  audit: AuditService;
}

let cached: ReviewerHandlerDeps | null = null;

function getDeps(): ReviewerHandlerDeps {
  if (cached) return cached;
  const cfg = getConfig();
  const client = createDocumentClient();
  const reviewerRepo = new ReviewerRepo(client, cfg.tableName);
  const moduleRepo = new ModuleRepo(client, cfg.tableName);
  const assignmentRepo = new AssignmentRepo(client, cfg.tableName);
  const auditRepo = new AuditRepo(client, cfg.tableName);
  const cognito = new CognitoAdminClient(cfg.userPoolId, { region: cfg.region });

  cached = {
    reviewerService: new ReviewerService({ reviewerRepo, assignmentRepo, cognito }),
    assignmentService: new AssignmentService({ assignmentRepo, moduleRepo, reviewerRepo }),
    audit: new AuditService(auditRepo),
  };
  return cached;
}

/** For tests: inject deps and reset the cache. */
export function __setDeps(deps: ReviewerHandlerDeps | null): void {
  cached = deps;
}

/**
 * Routes:
 *   POST   /v1/reviewers
 *   GET    /v1/reviewers
 *   POST   /v1/reviewers/{id}/deactivate
 *   POST   /v1/reviewers/{id}/assignments
 *   PATCH  /v1/reviewers/{id}/assignments/{moduleId}
 *   DELETE /v1/reviewers/{id}/assignments/{moduleId}
 *
 * All require the 'admin' role (R2.5).
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const ctx = getAuthContext(event);
    requireRole(ctx, UserRole.ADMIN);

    const { reviewerService, assignmentService, audit } = getDeps();
    const method = event.requestContext.http.method;
    const reviewerId = event.pathParameters?.id;
    const moduleId = event.pathParameters?.moduleId;
    const path = event.requestContext.http.path;

    const isAssignmentRoute = path.includes('/assignments');
    const isDeactivateRoute = path.endsWith('/deactivate');

    // --- Assignment routes ---
    if (isAssignmentRoute) {
      if (!reviewerId) throw new NotFoundError('Reviewer', '(missing id)');

      switch (method) {
        case 'POST': {
          const input = validate(createAssignmentSchema, parseJsonBody(event.body));
          const assignment = await assignmentService.assign(
            reviewerId,
            input.moduleId,
            input.permission,
          );
          await audit.record({
            actor: ctx.userId,
            action: 'create_assignment',
            target: `USER#${reviewerId}`,
            details: { moduleId: input.moduleId, permission: input.permission },
          });
          return created(assignment);
        }
        case 'PATCH': {
          if (!moduleId) throw new NotFoundError('Assignment', '(missing moduleId)');
          const input = validate(updateAssignmentSchema, parseJsonBody(event.body));
          await assignmentService.updatePermission(reviewerId, moduleId, input.permission);
          await audit.record({
            actor: ctx.userId,
            action: 'update_assignment',
            target: `USER#${reviewerId}`,
            details: { moduleId, permission: input.permission },
          });
          return ok({ reviewerId, moduleId, permission: input.permission });
        }
        case 'DELETE': {
          if (!moduleId) throw new NotFoundError('Assignment', '(missing moduleId)');
          await assignmentService.remove(reviewerId, moduleId);
          await audit.record({
            actor: ctx.userId,
            action: 'delete_assignment',
            target: `USER#${reviewerId}`,
            details: { moduleId },
          });
          return noContent();
        }
        default:
          return errorResponse(new NotFoundError('Route', method));
      }
    }

    // --- Deactivate route ---
    if (isDeactivateRoute && method === 'POST') {
      if (!reviewerId) throw new NotFoundError('Reviewer', '(missing id)');
      await reviewerService.deactivate(reviewerId);
      await audit.record({
        actor: ctx.userId,
        action: 'deactivate_reviewer',
        target: `USER#${reviewerId}`,
      });
      return ok({ id: reviewerId, active: false });
    }

    // --- Reviewer collection routes ---
    switch (method) {
      case 'POST': {
        const input = validate(createReviewerSchema, parseJsonBody(event.body));
        const reviewer = await reviewerService.create(input.email, input.name);
        await audit.record({
          actor: ctx.userId,
          action: 'create_reviewer',
          target: `USER#${reviewer.id}`,
          details: { email: reviewer.email },
        });
        return created(reviewer);
      }
      case 'GET': {
        if (reviewerId) return ok(await reviewerService.get(reviewerId));
        return ok(await reviewerService.list());
      }
      default:
        return errorResponse(new NotFoundError('Route', method));
    }
  } catch (err) {
    return errorResponse(err);
  }
}
