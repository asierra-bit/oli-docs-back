import { describe, it, expect, vi } from 'vitest';
import { ModuleService } from './module-service.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { Module } from '../domain/entities.js';

function makeDeps(overrides?: {
  moduleRepo?: Partial<{
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    updateName: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }>;
  hasDocs?: boolean;
  hasAssignments?: boolean;
}) {
  const moduleRepo = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    updateName: vi.fn(),
    delete: vi.fn(),
    ...overrides?.moduleRepo,
  };
  const documentRepo = {
    hasDocumentsForModule: vi.fn().mockResolvedValue(overrides?.hasDocs ?? false),
  };
  const assignmentRepo = {
    hasAssignmentsForModule: vi.fn().mockResolvedValue(overrides?.hasAssignments ?? false),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { moduleRepo, documentRepo, assignmentRepo } as any;
}

const existing: Module = { id: 'm1', name: 'ventas', createdAt: '2026-01-01T00:00:00Z' };

describe('ModuleService.create', () => {
  it('creates a module with a generated id', async () => {
    const deps = makeDeps();
    deps.moduleRepo.create.mockImplementation(async (m: Module) => m);
    const svc = new ModuleService(deps);

    const result = await svc.create('marca');
    expect(result.name).toBe('marca');
    expect(result.id).toBeTypeOf('string');
    expect(result.createdAt).toBeDefined();
  });

  it('propagates ConflictError (409) from the repo on duplicate name', async () => {
    const deps = makeDeps();
    deps.moduleRepo.create.mockRejectedValue(new ConflictError('exists'));
    const svc = new ModuleService(deps);
    await expect(svc.create('ventas')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('ModuleService.get', () => {
  it('returns the module', async () => {
    const deps = makeDeps();
    deps.moduleRepo.get.mockResolvedValue(existing);
    const svc = new ModuleService(deps);
    expect(await svc.get('m1')).toEqual(existing);
  });

  it('throws NotFound when absent', async () => {
    const deps = makeDeps();
    deps.moduleRepo.get.mockResolvedValue(null);
    const svc = new ModuleService(deps);
    await expect(svc.get('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ModuleService.updateName', () => {
  it('loads current then updates', async () => {
    const deps = makeDeps();
    deps.moduleRepo.get.mockResolvedValue(existing);
    deps.moduleRepo.updateName.mockResolvedValue({ ...existing, name: 'nuevo' });
    const svc = new ModuleService(deps);
    const result = await svc.updateName('m1', 'nuevo');
    expect(result.name).toBe('nuevo');
    expect(deps.moduleRepo.updateName).toHaveBeenCalledWith('m1', 'nuevo', existing);
  });
});

describe('ModuleService.delete', () => {
  it('deletes when no dependencies', async () => {
    const deps = makeDeps({ hasDocs: false, hasAssignments: false });
    deps.moduleRepo.get.mockResolvedValue(existing);
    const svc = new ModuleService(deps);
    await svc.delete('m1');
    expect(deps.moduleRepo.delete).toHaveBeenCalledWith('m1', 'ventas');
  });

  it('throws ConflictError (409) when documents are linked', async () => {
    const deps = makeDeps({ hasDocs: true });
    deps.moduleRepo.get.mockResolvedValue(existing);
    const svc = new ModuleService(deps);
    await expect(svc.delete('m1')).rejects.toBeInstanceOf(ConflictError);
    expect(deps.moduleRepo.delete).not.toHaveBeenCalled();
  });

  it('throws ConflictError (409) when assignments are linked', async () => {
    const deps = makeDeps({ hasAssignments: true });
    deps.moduleRepo.get.mockResolvedValue(existing);
    const svc = new ModuleService(deps);
    await expect(svc.delete('m1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('conflict lists both dependencies when both present', async () => {
    const deps = makeDeps({ hasDocs: true, hasAssignments: true });
    deps.moduleRepo.get.mockResolvedValue(existing);
    const svc = new ModuleService(deps);
    try {
      await svc.delete('m1');
      expect.unreachable();
    } catch (err) {
      const ce = err as ConflictError;
      expect(ce.message).toContain('documents');
      expect(ce.message).toContain('assignments');
      expect(ce.details).toHaveLength(2);
    }
  });

  it('throws NotFound when module missing', async () => {
    const deps = makeDeps();
    deps.moduleRepo.get.mockResolvedValue(null);
    const svc = new ModuleService(deps);
    await expect(svc.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
