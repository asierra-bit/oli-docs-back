import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getConfig } from '../../lib/config.js';
import { validate, createModuleSchema, updateModuleSchema } from '../../lib/validation.js';
import { NotFoundError } from '../../lib/errors.js';
import { UserRole } from '../../domain/enums.js';
import { createDocumentClient } from '../../repositories/dynamo/client.js';
import { ModuleRepo } from '../../repositories/dynamo/module-repo.js';
import { DocumentRepo } from '../../repositories/dynamo/document-repo.js';
import { AssignmentRepo } from '../../repositories/dynamo/assignment-repo.js';
import { AuditRepo } from '../../repositories/dynamo/audit-repo.js';
import { ModuleService } from '../../services/module-service.js';
import { AuditService } from '../../services/audit-service.js';
import { getAuthContext } from '../auth/context.js';
import { requireRole } from '../auth/guards.js';
import { ok, created, noContent, errorResponse, parseJsonBody } from './response.js';

/** Lazily-built dependencies, reused across warm invocations. */
let cached: { service: ModuleService; audit: AuditService } | null = null;

function getDeps(): { service: ModuleService; audit: AuditService } {
  if (cached) return cached;
  const cfg = getConfig();
  const client = createDocumentClient();
  const moduleRepo = new ModuleRepo(client, cfg.tableName);
  const documentRepo = new DocumentRepo(client, cfg.tableName);
  const assignmentRepo = new AssignmentRepo(client, cfg.tableName);
  const auditRepo = new AuditRepo(client, cfg.tableName);
  cached = {
    service: new ModuleService({ moduleRepo, documentRepo, assignmentRepo }),
    audit: new AuditService(auditRepo),
  };
  return cached;
}

/** For tests: inject deps and reset the cache. */
export function __setDeps(deps: { service: ModuleService; audit: AuditService } | null): void {
  cached = deps;
}

/**
 * Router for /v1/modules endpoints (R1).
 * All operations require the 'admin' role (R1.2).
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const ctx = getAuthContext(event);
    requireRole(ctx, UserRole.ADMIN);

    const { service, audit } = getDeps();
    const method = event.requestContext.http.method;
    const moduleId = event.pathParameters?.id;

    switch (method) {
      case 'POST': {
        const input = validate(createModuleSchema, parseJsonBody(event.body));
        const module = await service.create(input.name);
        await audit.record({
          actor: ctx.userId,
          action: 'create_module',
          target: `MODULE#${module.id}`,
          details: { name: module.name },
        });
        return created(module);
      }

      case 'GET': {
        if (moduleId) {
          return ok(await service.get(moduleId));
        }
        return ok(await service.list());
      }

      case 'PATCH': {
        if (!moduleId) throw new NotFoundError('Module', '(missing id)');
        const input = validate(updateModuleSchema, parseJsonBody(event.body));
        const module = await service.updateName(moduleId, input.name);
        await audit.record({
          actor: ctx.userId,
          action: 'update_module',
          target: `MODULE#${moduleId}`,
          details: { name: input.name },
        });
        return ok(module);
      }

      case 'DELETE': {
        if (!moduleId) throw new NotFoundError('Module', '(missing id)');
        await service.delete(moduleId);
        await audit.record({
          actor: ctx.userId,
          action: 'delete_module',
          target: `MODULE#${moduleId}`,
        });
        return noContent();
      }

      default:
        return errorResponse(new NotFoundError('Route', method));
    }
  } catch (err) {
    return errorResponse(err);
  }
}
