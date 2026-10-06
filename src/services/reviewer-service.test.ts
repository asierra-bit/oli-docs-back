import { describe, it, expect, vi } from 'vitest';
import { ReviewerService } from './reviewer-service.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { UserRole } from '../domain/enums.js';
import type { Reviewer } from '../domain/entities.js';

function makeDeps(overrides?: {
  reviewerRepo?: Record<string, ReturnType<typeof vi.fn>>;
  assignmentRepo?: Record<string, ReturnType<typeof vi.fn>>;
  cognito?: Record<string, ReturnType<typeof vi.fn>>;
}) {
  const reviewerRepo = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    setActive: vi.fn(),
    ...overrides?.reviewerRepo,
  };
  const assignmentRepo = {
    listForReviewer: vi.fn().mockResolvedValue([]),
    ...overrides?.assignmentRepo,
  };
  const cognito = {
    createReviewer: vi.fn(),
    disableUser: vi.fn(),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    ...overrides?.cognito,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { reviewerRepo, assignmentRepo, cognito } as any;
}

describe('ReviewerService.create', () => {
  it('creates in Cognito then persists with sub as id and REVIEWER role', async () => {
    const deps = makeDeps();
    deps.cognito.createReviewer.mockResolvedValue('sub-123');
    deps.reviewerRepo.create.mockImplementation(async (r: Reviewer) => r);

    const result = await new ReviewerService(deps).create('ana@example.com', 'Ana');

    expect(deps.cognito.createReviewer).toHaveBeenCalledWith('ana@example.com', 'Ana');
    expect(result.id).toBe('sub-123');
    expect(result.role).toBe(UserRole.REVIEWER);
    expect(result.active).toBe(true);
  });

  it('maps Cognito UsernameExistsException to ConflictError (409)', async () => {
    const deps = makeDeps();
    deps.cognito.createReviewer.mockRejectedValue(
      Object.assign(new Error('dup'), { name: 'UsernameExistsException' }),
    );
    await expect(
      new ReviewerService(deps).create('ana@example.com', 'Ana'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(deps.reviewerRepo.create).not.toHaveBeenCalled();
  });

  it('propagates repo ConflictError (409) and compensates by deleting the Cognito user', async () => {
    const deps = makeDeps();
    deps.cognito.createReviewer.mockResolvedValue('sub-123');
    deps.reviewerRepo.create.mockRejectedValue(new ConflictError('already registered'));
    await expect(
      new ReviewerService(deps).create('ana@example.com', 'Ana'),
    ).rejects.toBeInstanceOf(ConflictError);
    // Compensation: the orphaned Cognito user is deleted by email (username).
    expect(deps.cognito.deleteUser).toHaveBeenCalledWith('ana@example.com');
  });

  it('still throws the original error if compensation also fails', async () => {
    const deps = makeDeps();
    deps.cognito.createReviewer.mockResolvedValue('sub-123');
    deps.reviewerRepo.create.mockRejectedValue(new Error('ddb down'));
    deps.cognito.deleteUser.mockRejectedValue(new Error('cleanup failed'));
    await expect(
      new ReviewerService(deps).create('ana@example.com', 'Ana'),
    ).rejects.toThrow('ddb down');
  });

  it('rethrows unexpected Cognito errors', async () => {
    const deps = makeDeps();
    deps.cognito.createReviewer.mockRejectedValue(new Error('network'));
    await expect(new ReviewerService(deps).create('a@b.com', 'A')).rejects.toThrow('network');
  });
});

describe('ReviewerService.list', () => {
  it('returns reviewers with their assignments', async () => {
    const deps = makeDeps();
    deps.reviewerRepo.list.mockResolvedValue([
      { id: 'u1', email: 'a@b.com', name: 'A', role: UserRole.REVIEWER, active: true, createdAt: 'now' },
    ]);
    deps.assignmentRepo.listForReviewer.mockResolvedValue([
      { reviewerId: 'u1', moduleId: 'm1', permission: 'edit', createdAt: 'now' },
    ]);

    const result = await new ReviewerService(deps).list();
    expect(result).toHaveLength(1);
    expect(result[0]!.assignments).toHaveLength(1);
    expect(result[0]!.assignments[0]!.moduleId).toBe('m1');
  });
});

describe('ReviewerService.deactivate', () => {
  const reviewer: Reviewer = {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    role: UserRole.REVIEWER,
    active: true,
    createdAt: 'now',
  };

  it('disables in Cognito by email and flags inactive, preserving history', async () => {
    const deps = makeDeps();
    deps.reviewerRepo.get.mockResolvedValue(reviewer);
    await new ReviewerService(deps).deactivate('u1');
    // Disable by email (the Cognito username), not the sub.
    expect(deps.cognito.disableUser).toHaveBeenCalledWith('a@b.com');
    expect(deps.reviewerRepo.setActive).toHaveBeenCalledWith('u1', false);
  });

  it('throws NotFound for unknown reviewer', async () => {
    const deps = makeDeps();
    deps.reviewerRepo.get.mockResolvedValue(null);
    await expect(new ReviewerService(deps).deactivate('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(deps.cognito.disableUser).not.toHaveBeenCalled();
  });
});
