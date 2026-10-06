import type { Reviewer, Assignment } from '../domain/entities.js';
import { UserRole } from '../domain/enums.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { ReviewerRepo } from '../repositories/dynamo/reviewer-repo.js';
import type { AssignmentRepo } from '../repositories/dynamo/assignment-repo.js';
import type { CognitoAdmin } from '../providers/cognito/cognito-admin.js';

export interface ReviewerWithAssignments extends Reviewer {
  assignments: Assignment[];
}

export interface ReviewerServiceDeps {
  reviewerRepo: ReviewerRepo;
  assignmentRepo: Pick<AssignmentRepo, 'listForReviewer'>;
  cognito: CognitoAdmin;
}

/** True if the error is Cognito's duplicate-username signal. */
function isCognitoUserExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'UsernameExistsException'
  );
}

/**
 * Business logic for reviewers (R2).
 */
export class ReviewerService {
  constructor(private readonly deps: ReviewerServiceDeps) {}

  /**
   * Create a reviewer: register in Cognito (revisor group) then persist local
   * metadata. The Cognito user id (`sub`) becomes the reviewer id so it lines
   * up with the JWT subject used by the guards (R2.1).
   */
  async create(email: string, name: string): Promise<Reviewer> {
    let userId: string;
    try {
      userId = await this.deps.cognito.createReviewer(email, name);
    } catch (err) {
      if (isCognitoUserExists(err)) {
        throw new ConflictError(`Email '${email}' is already registered`);
      }
      throw err;
    }

    const reviewer: Reviewer = {
      id: userId,
      email,
      name,
      role: UserRole.REVIEWER,
      active: true,
      createdAt: new Date().toISOString(),
    };

    // Dual-write: the Cognito user already exists. If the local write fails we
    // must compensate by deleting the Cognito user, otherwise we'd leak an
    // orphaned user and make the email permanently unregisterable (the retry
    // would hit UsernameExistsException). ReviewerRepo.create enforces email
    // uniqueness via TransactWriteItems and maps a conflict to ConflictError.
    try {
      return await this.deps.reviewerRepo.create(reviewer);
    } catch (err) {
      try {
        await this.deps.cognito.deleteUser(email);
      } catch (cleanupErr) {
        // Compensation failed — surface loudly; a dangling Cognito user remains.
        logger.error('Failed to roll back Cognito user after local write failure', {
          email,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
      throw err;
    }
  }

  /** List reviewers with their module assignments (R2.3). */
  async list(): Promise<ReviewerWithAssignments[]> {
    const reviewers = await this.deps.reviewerRepo.list();
    return Promise.all(
      reviewers.map(async (r) => ({
        ...r,
        assignments: await this.deps.assignmentRepo.listForReviewer(r.id),
      })),
    );
  }

  async get(userId: string): Promise<Reviewer> {
    const reviewer = await this.deps.reviewerRepo.get(userId);
    if (!reviewer) throw new NotFoundError('Reviewer', userId);
    return reviewer;
  }

  /**
   * Deactivate a reviewer: disable in Cognito (blocks auth) and flag inactive
   * locally. Historical review records are preserved (R2.4).
   */
  async deactivate(userId: string): Promise<void> {
    const reviewer = await this.get(userId); // 404 if unknown
    // The pool uses the email as the Cognito username, so disable by email,
    // not by the sub (`userId`), which AdminDisableUser does not accept.
    await this.deps.cognito.disableUser(reviewer.email);
    await this.deps.reviewerRepo.setActive(userId, false);
  }
}
