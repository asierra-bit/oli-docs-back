import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../lib/errors.js';
import { Permission, UserRole, type Permission as PermissionType } from '../../domain/enums.js';
import type { AuthContext } from './context.js';
import { hasRole } from './context.js';
import type { AssignmentRepo } from '../../repositories/dynamo/assignment-repo.js';
import type { DocumentRepo } from '../../repositories/dynamo/document-repo.js';

/** Throws if the principal is not authenticated (R10.3). */
export function requireAuth(ctx: AuthContext | null | undefined): asserts ctx is AuthContext {
  if (!ctx || !ctx.userId) {
    throw new UnauthenticatedError();
  }
}

/** Throws if the principal lacks the required role (R10.4). */
export function requireRole(ctx: AuthContext, role: (typeof UserRole)[keyof typeof UserRole]): void {
  requireAuth(ctx);
  if (!hasRole(ctx, role)) {
    throw new ForbiddenError(`Requires role '${role}'`);
  }
}

/** Permission ordering: 'edit' satisfies a 'read' requirement, not vice-versa. */
function permissionSatisfies(held: PermissionType, required: PermissionType): boolean {
  if (required === Permission.READ) return held === Permission.READ || held === Permission.EDIT;
  return held === Permission.EDIT;
}

export interface ModuleAccessDeps {
  documentRepo: Pick<DocumentRepo, 'get'>;
  assignmentRepo: Pick<AssignmentRepo, 'get'>;
}

/**
 * Verifies the reviewer has an assignment to the document's module with at
 * least the required permission level (R3.6, R8.4, R10.5).
 *
 * Admins bypass module-level checks. A document with no module yet cannot be
 * accessed by a reviewer.
 */
export async function requireModuleAccess(
  ctx: AuthContext,
  documentId: string,
  required: PermissionType,
  deps: ModuleAccessDeps,
): Promise<void> {
  requireAuth(ctx);

  // Admins have unrestricted access.
  if (hasRole(ctx, UserRole.ADMIN)) return;

  const doc = await deps.documentRepo.get(documentId);
  if (!doc) {
    throw new NotFoundError('Document', documentId);
  }
  if (!doc.moduleId) {
    throw new ForbiddenError('Document is not yet assigned to a module');
  }

  const assignment = await deps.assignmentRepo.get(ctx.userId, doc.moduleId);
  if (!assignment) {
    throw new ForbiddenError('No assignment to this document module');
  }

  if (!permissionSatisfies(assignment.permission, required)) {
    throw new ForbiddenError(`Requires '${required}' permission on the module`);
  }
}

/**
 * Verifies the principal owns the review record identified by
 * (documentId, reviewerId). A reviewer may only operate on their own
 * records (R7.4). Admins are allowed (e.g. for reopen).
 */
export function requireRecordOwner(
  ctx: AuthContext,
  recordReviewerId: string,
): void {
  requireAuth(ctx);
  if (hasRole(ctx, UserRole.ADMIN)) return;
  if (ctx.userId !== recordReviewerId) {
    throw new ForbiddenError('Cannot access another reviewer\'s record');
  }
}
