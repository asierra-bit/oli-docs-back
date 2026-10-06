import { describe, it, expect, vi } from 'vitest';
import { AssignmentService } from './assignment-service.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import type { Assignment, Module, Reviewer } from '../domain/entities.js';
import { UserRole } from '../domain/enums.js';

const module: Module = { id: 'm1', name: 'ventas', createdAt: 'now' };
const reviewer: Reviewer = {
  id: 'u1',
  email: 'a@b.com',
  name: 'A',
  role: UserRole.REVIEWER,
  active: true,
  createdAt: 'now',
};

function makeDeps(opts?: { module?: Module | null; reviewer?: Reviewer | null }) {
  const assignmentRepo = {
    put: vi.fn().mockImplementation(async (a: Assignment) => a),
    get: vi.fn(),
    updatePermission: vi.fn(),
    remove: vi.fn(),
    listForReviewer: vi.fn().mockResolvedValue([]),
  };
  // Use `in` checks so an explicit `null` override is honoured (||/?? would
  // treat null as "use default").
  const moduleValue = opts && 'module' in opts ? opts.module : module;
  const reviewerValue = opts && 'reviewer' in opts ? opts.reviewer : reviewer;
  const moduleRepo = { get: vi.fn().mockResolvedValue(moduleValue) };
  const reviewerRepo = { get: vi.fn().mockResolvedValue(reviewerValue) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { assignmentRepo, moduleRepo, reviewerRepo } as any;
}

describe('AssignmentService.assign', () => {
  it('persists an assignment when module and reviewer exist', async () => {
    const deps = makeDeps();
    const result = await new AssignmentService(deps).assign('u1', 'm1', 'edit');
    expect(result.permission).toBe('edit');
    expect(deps.assignmentRepo.put).toHaveBeenCalledOnce();
  });

  it('throws ValidationError (400) when reviewer does not exist', async () => {
    const deps = makeDeps({ reviewer: null });
    await expect(
      new AssignmentService(deps).assign('ghost', 'm1', 'read'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(deps.assignmentRepo.put).not.toHaveBeenCalled();
  });

  it('throws ValidationError (400) when module does not exist', async () => {
    const deps = makeDeps({ module: null });
    await expect(
      new AssignmentService(deps).assign('u1', 'ghost', 'read'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('AssignmentService.updatePermission', () => {
  it('updates when the assignment exists', async () => {
    const deps = makeDeps();
    deps.assignmentRepo.get.mockResolvedValue({
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'read',
      createdAt: 'now',
    });
    await new AssignmentService(deps).updatePermission('u1', 'm1', 'edit');
    expect(deps.assignmentRepo.updatePermission).toHaveBeenCalledWith('u1', 'm1', 'edit');
  });

  it('throws NotFound when the assignment is absent', async () => {
    const deps = makeDeps();
    deps.assignmentRepo.get.mockResolvedValue(null);
    await expect(
      new AssignmentService(deps).updatePermission('u1', 'm1', 'edit'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AssignmentService.remove & list', () => {
  it('remove delegates to the repo', async () => {
    const deps = makeDeps();
    await new AssignmentService(deps).remove('u1', 'm1');
    expect(deps.assignmentRepo.remove).toHaveBeenCalledWith('u1', 'm1');
  });

  it('listForReviewer returns assignments with permission levels', async () => {
    const deps = makeDeps();
    deps.assignmentRepo.listForReviewer.mockResolvedValue([
      { reviewerId: 'u1', moduleId: 'm1', permission: 'read', createdAt: 'now' },
    ]);
    const result = await new AssignmentService(deps).listForReviewer('u1');
    expect(result[0]!.permission).toBe('read');
  });
});
