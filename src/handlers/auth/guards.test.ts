import { describe, it, expect, vi } from 'vitest';
import {
  requireAuth,
  requireRole,
  requireModuleAccess,
  requireRecordOwner,
} from './guards.js';
import type { AuthContext } from './context.js';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../lib/errors.js';
import { Permission, UserRole } from '../../domain/enums.js';
import type { Document, Assignment } from '../../domain/entities.js';

const admin: AuthContext = { userId: 'admin-1', roles: [UserRole.ADMIN] };
const reviewer: AuthContext = { userId: 'u1', roles: [UserRole.REVIEWER] };

describe('requireAuth', () => {
  it('passes with a valid context', () => {
    expect(() => requireAuth(reviewer)).not.toThrow();
  });

  it('throws when null', () => {
    expect(() => requireAuth(null)).toThrow(UnauthenticatedError);
  });

  it('throws when userId is empty', () => {
    expect(() => requireAuth({ userId: '', roles: [] })).toThrow(UnauthenticatedError);
  });
});

describe('requireRole', () => {
  it('passes when role matches', () => {
    expect(() => requireRole(admin, UserRole.ADMIN)).not.toThrow();
  });

  it('throws Forbidden when role missing', () => {
    expect(() => requireRole(reviewer, UserRole.ADMIN)).toThrow(ForbiddenError);
  });
});

describe('requireModuleAccess', () => {
  const doc: Document = {
    id: 'd1',
    name: 'g.md',
    s3Key: 'documents/d1.md',
    status: 'classified',
    moduleId: 'm1',
    approvalPolicy: 'all',
    createdAt: '2026-01-01T00:00:00Z',
  };

  function deps(docValue: Document | null, assignment: Assignment | null) {
    return {
      documentRepo: { get: vi.fn().mockResolvedValue(docValue) },
      assignmentRepo: { get: vi.fn().mockResolvedValue(assignment) },
    };
  }

  it('admin bypasses module checks without repo calls', async () => {
    const d = deps(null, null);
    await expect(requireModuleAccess(admin, 'd1', Permission.EDIT, d)).resolves.toBeUndefined();
    expect(d.documentRepo.get).not.toHaveBeenCalled();
  });

  it('throws NotFound when document missing', async () => {
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.READ, deps(null, null)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws Forbidden when document has no module', async () => {
    const noModuleDoc = { ...doc, moduleId: undefined };
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.READ, deps(noModuleDoc, null)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws Forbidden when no assignment', async () => {
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.READ, deps(doc, null)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows read when reviewer has read permission', async () => {
    const assignment: Assignment = {
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'read',
      createdAt: '2026-01-01T00:00:00Z',
    };
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.READ, deps(doc, assignment)),
    ).resolves.toBeUndefined();
  });

  it('denies edit when reviewer only has read permission', async () => {
    const assignment: Assignment = {
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'read',
      createdAt: '2026-01-01T00:00:00Z',
    };
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.EDIT, deps(doc, assignment)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('edit permission satisfies a read requirement', async () => {
    const assignment: Assignment = {
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'edit',
      createdAt: '2026-01-01T00:00:00Z',
    };
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.READ, deps(doc, assignment)),
    ).resolves.toBeUndefined();
  });

  it('edit permission satisfies an edit requirement', async () => {
    const assignment: Assignment = {
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'edit',
      createdAt: '2026-01-01T00:00:00Z',
    };
    await expect(
      requireModuleAccess(reviewer, 'd1', Permission.EDIT, deps(doc, assignment)),
    ).resolves.toBeUndefined();
  });
});

describe('requireRecordOwner', () => {
  it('allows the owner', () => {
    expect(() => requireRecordOwner(reviewer, 'u1')).not.toThrow();
  });

  it('allows an admin on any record', () => {
    expect(() => requireRecordOwner(admin, 'u1')).not.toThrow();
  });

  it('denies a different reviewer', () => {
    expect(() => requireRecordOwner(reviewer, 'other-user')).toThrow(ForbiddenError);
  });
});
