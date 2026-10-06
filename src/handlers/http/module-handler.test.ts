import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler, __setDeps } from './module-handler.js';
import { ConflictError } from '../../lib/errors.js';
import type { ModuleService } from '../../services/module-service.js';
import type { AuditService } from '../../services/audit-service.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function makeEvent(opts: {
  method: Method;
  roles?: string[];
  id?: string;
  body?: unknown;
  anonymous?: boolean;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims = opts.anonymous
    ? undefined
    : { sub: 'admin-1', 'cognito:groups': opts.roles ?? ['admin'] };
  return {
    requestContext: {
      http: { method: opts.method },
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
    pathParameters: opts.id ? { id: opts.id } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function mockDeps() {
  const service = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    updateName: vi.fn(),
    delete: vi.fn(),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  __setDeps({
    service: service as unknown as ModuleService,
    audit: audit as unknown as AuditService,
  });
  return { service, audit };
}

describe('module-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDeps(null);
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockDeps();
    const res = await handler(makeEvent({ method: 'GET', anonymous: true }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin with 403', async () => {
    mockDeps();
    const res = await handler(makeEvent({ method: 'GET', roles: ['revisor'] }));
    expect(res.statusCode).toBe(403);
  });

  it('POST creates a module (201) and records audit', async () => {
    const { service, audit } = mockDeps();
    service.create.mockResolvedValue({ id: 'm1', name: 'ventas', createdAt: 'now' });
    const res = await handler(makeEvent({ method: 'POST', body: { name: 'ventas' } }));
    expect(res.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith('ventas');
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('POST with invalid body returns 400', async () => {
    mockDeps();
    const res = await handler(makeEvent({ method: 'POST', body: { name: '' } }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body as string);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET list returns 200', async () => {
    const { service } = mockDeps();
    service.list.mockResolvedValue([{ id: 'm1', name: 'ventas', createdAt: 'now' }]);
    const res = await handler(makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toHaveLength(1);
  });

  it('GET by id returns the module', async () => {
    const { service } = mockDeps();
    service.get.mockResolvedValue({ id: 'm1', name: 'ventas', createdAt: 'now' });
    const res = await handler(makeEvent({ method: 'GET', id: 'm1' }));
    expect(res.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith('m1');
  });

  it('PATCH updates the name', async () => {
    const { service } = mockDeps();
    service.updateName.mockResolvedValue({ id: 'm1', name: 'nuevo', createdAt: 'now' });
    const res = await handler(makeEvent({ method: 'PATCH', id: 'm1', body: { name: 'nuevo' } }));
    expect(res.statusCode).toBe(200);
    expect(service.updateName).toHaveBeenCalledWith('m1', 'nuevo');
  });

  it('DELETE returns 204', async () => {
    const { service } = mockDeps();
    service.delete.mockResolvedValue(undefined);
    const res = await handler(makeEvent({ method: 'DELETE', id: 'm1' }));
    expect(res.statusCode).toBe(204);
  });

  it('DELETE with dependencies surfaces 409', async () => {
    const { service } = mockDeps();
    service.delete.mockRejectedValue(new ConflictError('has deps'));
    const res = await handler(makeEvent({ method: 'DELETE', id: 'm1' }));
    expect(res.statusCode).toBe(409);
  });

  it('POST duplicate name surfaces 409', async () => {
    const { service } = mockDeps();
    service.create.mockRejectedValue(new ConflictError('exists'));
    const res = await handler(makeEvent({ method: 'POST', body: { name: 'ventas' } }));
    expect(res.statusCode).toBe(409);
  });
});
