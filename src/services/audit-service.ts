import { ulid } from 'ulid';
import type { AuditLog } from '../domain/entities.js';
import type { AuditRepo } from '../repositories/dynamo/audit-repo.js';
import { logger } from '../lib/logger.js';

/**
 * Records sensitive operations for audit (R10.6): user creation, assignment
 * changes, approval-policy changes, forced approvals, etc.
 *
 * Audit writes are best-effort: a failure to log must not block the primary
 * operation, so errors are swallowed and logged.
 */
export class AuditService {
  constructor(private readonly auditRepo: Pick<AuditRepo, 'append'>) {}

  async record(params: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const entry: AuditLog = {
      id: ulid(),
      actor: params.actor,
      action: params.action,
      target: params.target,
      details: params.details,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.auditRepo.append(entry);
    } catch (err) {
      logger.error('Failed to write audit log', {
        action: params.action,
        target: params.target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
