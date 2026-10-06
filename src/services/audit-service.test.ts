import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit-service.js';

describe('AuditService', () => {
  it('appends an audit entry with generated id and timestamp', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const svc = new AuditService({ append });

    await svc.record({
      actor: 'admin-1',
      action: 'create_module',
      target: 'MODULE#m1',
      details: { name: 'ventas' },
    });

    expect(append).toHaveBeenCalledOnce();
    const entry = append.mock.calls[0]![0];
    expect(entry.actor).toBe('admin-1');
    expect(entry.action).toBe('create_module');
    expect(entry.target).toBe('MODULE#m1');
    expect(entry.details).toEqual({ name: 'ventas' });
    expect(entry.id).toBeTypeOf('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.timestamp).toBeDefined();
  });

  it('does not throw when the repo append fails (best-effort)', async () => {
    const append = vi.fn().mockRejectedValue(new Error('ddb down'));
    const svc = new AuditService({ append });

    await expect(
      svc.record({ actor: 'a', action: 'x', target: 't' }),
    ).resolves.toBeUndefined();
  });
});
