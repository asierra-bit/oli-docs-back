import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler, __setDeps } from './reviewer-handler.js';
import type { ReviewerHandlerDeps } from './reviewer-handler.js';
import { ValidationError } from '../../lib/errors.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function makeEvent(opts: {
  method: Method;
  path: string;
  roles?: string[];
  id?: string;
  moduleId?: string;
  body?: unknown;
  anonymous?: boolean;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims = opts.anonymous
    ? undefined
    : { sub: 'admin-1', 'cognito:groups': opts.roles ?? ['admin'] };
  const pathParameters: Record<string, string> = {};
  if (opts.id) pathParameters.id = opts.id;
  if (opts.moduleId) pathParameters.moduleId = opts.moduleId;
  return {
    requestContext: {
      http: { method: opts.method, path: opts.path },
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
    pathParameters: Object.keys(pathParameters).length ? pathParameters : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function mockDeps() {
  const reviewerService = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    deactivate: vi.fn(),
  };
  const assignmentService = {
    assign: vi.fn(),
    updatePermission: vi.fn(),
    remove: vi.fn(),
    listForReviewer: vi.fn(),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  __setDeps({
    reviewerService,
    assignmentService,
    audit,
  } as unknown as ReviewerHandlerDeps);
  return { reviewerService, assignmentService, audit };
}

describe('reviewer-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDeps(null);
  });

  it('401 when unauthenticated', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/reviewers', anonymous: true }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('403 when not admin', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/reviewers', roles: ['revisor'] }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/reviewers creates (201) and audits', async () => {
    const { reviewerService, audit } = mockDeps();
    reviewerService.create.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/reviewers', body: { email: 'a@b.com', name: 'A' } }),
    );
    expect(res.statusCode).toBe(201);
    expect(reviewerService.create).toHaveBeenCalledWith('a@b.com', 'A');
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('POST /v1/reviewers with invalid email returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/reviewers', body: { email: 'bad', name: 'A' } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/reviewers lists', async () => {
    const { reviewerService } = mockDeps();
    reviewerService.list.mockResolvedValue([]);
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/reviewers' }));
    expect(res.statusCode).toBe(200);
    expect(reviewerService.list).toHaveBeenCalled();
  });

  it('POST /deactivate deactivates reviewer', async () => {
    const { reviewerService } = mockDeps();
    reviewerService.deactivate.mockResolvedValue(undefined);
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/reviewers/u1/deactivate', id: 'u1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(reviewerService.deactivate).toHaveBeenCalledWith('u1');
  });

  it('POST assignment creates (201)', async () => {
    const { assignmentService } = mockDeps();
    assignmentService.assign.mockResolvedValue({
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'edit',
    });
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/reviewers/u1/assignments',
        id: 'u1',
        body: { moduleId: 'm1', permission: 'edit' },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(assignmentService.assign).toHaveBeenCalledWith('u1', 'm1', 'edit');
  });

  it('POST assignment with invalid permission returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/reviewers/u1/assignments',
        id: 'u1',
        body: { moduleId: 'm1', permission: 'owner' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('assign surfaces ValidationError (400) for unknown module', async () => {
    const { assignmentService } = mockDeps();
    assignmentService.assign.mockRejectedValue(
      new ValidationError('Module does not exist', [{ field: 'moduleId', issue: 'not_found' }]),
    );
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/reviewers/u1/assignments',
        id: 'u1',
        body: { moduleId: 'ghost', permission: 'read' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('PATCH assignment updates permission', async () => {
    const { assignmentService } = mockDeps();
    assignmentService.updatePermission.mockResolvedValue(undefined);
    const res = await handler(
      makeEvent({
        method: 'PATCH',
        path: '/v1/reviewers/u1/assignments/m1',
        id: 'u1',
        moduleId: 'm1',
        body: { permission: 'read' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(assignmentService.updatePermission).toHaveBeenCalledWith('u1', 'm1', 'read');
  });

  it('DELETE assignment returns 204', async () => {
    const { assignmentService } = mockDeps();
    assignmentService.remove.mockResolvedValue(undefined);
    const res = await handler(
      makeEvent({
        method: 'DELETE',
        path: '/v1/reviewers/u1/assignments/m1',
        id: 'u1',
        moduleId: 'm1',
      }),
    );
    expect(res.statusCode).toBe(204);
    expect(assignmentService.remove).toHaveBeenCalledWith('u1', 'm1');
  });
});
