import { ulid } from 'ulid';
import type { Module } from '../domain/entities.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { ModuleRepo } from '../repositories/dynamo/module-repo.js';
import type { DocumentRepo } from '../repositories/dynamo/document-repo.js';
import type { AssignmentRepo } from '../repositories/dynamo/assignment-repo.js';

export interface ModuleServiceDeps {
  moduleRepo: ModuleRepo;
  documentRepo: Pick<DocumentRepo, 'hasDocumentsForModule'>;
  assignmentRepo: Pick<AssignmentRepo, 'hasAssignmentsForModule'>;
}

/**
 * Business logic for modules (R1).
 */
export class ModuleService {
  constructor(private readonly deps: ModuleServiceDeps) {}

  /** Create a module with a unique name (R1.1, R1.5). */
  async create(name: string): Promise<Module> {
    const now = new Date().toISOString();
    const module: Module = { id: ulid(), name, createdAt: now };
    // ModuleRepo.create enforces name uniqueness → ConflictError (409).
    return this.deps.moduleRepo.create(module);
  }

  /** List all modules (R1.3). */
  async list(): Promise<Module[]> {
    return this.deps.moduleRepo.list();
  }

  async get(moduleId: string): Promise<Module> {
    const module = await this.deps.moduleRepo.get(moduleId);
    if (!module) throw new NotFoundError('Module', moduleId);
    return module;
  }

  /** Update a module's name (R1.4). */
  async updateName(moduleId: string, newName: string): Promise<Module> {
    const current = await this.get(moduleId);
    return this.deps.moduleRepo.updateName(moduleId, newName, current);
  }

  /**
   * Delete a module, rejecting if it has linked documents or assignments
   * (R1.6). Reports which dependencies block the deletion.
   *
   * Note on consistency: the dependency checks read GSI1, which is only
   * eventually consistent, so a document/assignment created moments before
   * this call may not yet be visible — a narrow TOCTOU window remains. The
   * delete itself is a conditional transaction (`attribute_exists(PK)`), so it
   * never silently "double-deletes", but it does not re-verify dependencies
   * atomically. For the event-scale workload this is acceptable; closing it
   * fully would require tracking a dependency counter on the module item and
   * guarding the delete transaction against it.
   */
  async delete(moduleId: string): Promise<void> {
    const current = await this.get(moduleId);

    const [hasDocs, hasAssignments] = await Promise.all([
      this.deps.documentRepo.hasDocumentsForModule(moduleId),
      this.deps.assignmentRepo.hasAssignmentsForModule(moduleId),
    ]);

    if (hasDocs || hasAssignments) {
      const deps: string[] = [];
      if (hasDocs) deps.push('documents');
      if (hasAssignments) deps.push('assignments');
      throw new ConflictError(
        `Cannot delete module '${moduleId}': it has linked ${deps.join(' and ')}`,
        deps.map((d) => ({ dependency: d })),
      );
    }

    await this.deps.moduleRepo.delete(moduleId, current.name);
  }
}
