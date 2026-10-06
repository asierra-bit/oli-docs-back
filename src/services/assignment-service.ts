import type { Assignment } from '../domain/entities.js';
import type { Permission } from '../domain/enums.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import type { AssignmentRepo } from '../repositories/dynamo/assignment-repo.js';
import type { ModuleRepo } from '../repositories/dynamo/module-repo.js';
import type { ReviewerRepo } from '../repositories/dynamo/reviewer-repo.js';

export interface AssignmentServiceDeps {
  assignmentRepo: AssignmentRepo;
  moduleRepo: Pick<ModuleRepo, 'get'>;
  reviewerRepo: Pick<ReviewerRepo, 'get'>;
}

/**
 * Business logic for reviewer ↔ module assignments (R3).
 */
export class AssignmentService {
  constructor(private readonly deps: AssignmentServiceDeps) {}

  /**
   * Assign a module to a reviewer with a permission level (R3.1).
   * Rejects unknown module/reviewer with a validation error (R3.3).
   * Permission values are validated at the handler via zod (R3.2); this
   * method defends again in case of non-HTTP callers.
   */
  async assign(
    reviewerId: string,
    moduleId: string,
    permission: Permission,
  ): Promise<Assignment> {
    await this.ensureEntitiesExist(reviewerId, moduleId);

    const assignment: Assignment = {
      reviewerId,
      moduleId,
      permission,
      createdAt: new Date().toISOString(),
    };
    return this.deps.assignmentRepo.put(assignment);
  }

  /** Update the permission level of an existing assignment (R3.4). */
  async updatePermission(
    reviewerId: string,
    moduleId: string,
    permission: Permission,
  ): Promise<void> {
    const existing = await this.deps.assignmentRepo.get(reviewerId, moduleId);
    if (!existing) {
      throw new NotFoundError('Assignment', `${reviewerId}/${moduleId}`);
    }
    await this.deps.assignmentRepo.updatePermission(reviewerId, moduleId, permission);
  }

  /** Remove an assignment (R3.5). */
  async remove(reviewerId: string, moduleId: string): Promise<void> {
    await this.deps.assignmentRepo.remove(reviewerId, moduleId);
  }

  /** List a reviewer's assignments with permission levels (R3.7). */
  async listForReviewer(reviewerId: string): Promise<Assignment[]> {
    return this.deps.assignmentRepo.listForReviewer(reviewerId);
  }

  /** Reject assignment to a non-existent module or reviewer (R3.3). */
  private async ensureEntitiesExist(reviewerId: string, moduleId: string): Promise<void> {
    const [reviewer, module] = await Promise.all([
      this.deps.reviewerRepo.get(reviewerId),
      this.deps.moduleRepo.get(moduleId),
    ]);
    if (!reviewer) {
      throw new ValidationError('Reviewer does not exist', [
        { field: 'reviewerId', issue: 'not_found' },
      ]);
    }
    if (!module) {
      throw new ValidationError('Module does not exist', [
        { field: 'moduleId', issue: 'not_found' },
      ]);
    }
  }
}
