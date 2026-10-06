import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler, __setDeps } from './document-handler.js';
import type { DocumentHandlerDeps } from './document-handler.js';
import { NotFoundError } from '../../lib/errors.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function makeEvent(opts: {
  method: Method;
  path: string;
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
      http: { method: opts.method, path: opts.path },
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
    pathParameters: opts.id ? { id: opts.id } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function mockDeps() {
  const documentService = {
    initUpload: vi.fn(),
    confirmUpload: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    reassignModule: vi.fn(),
    setApprovalPolicy: vi.fn(),
  };
  const approvalService = { evaluate: vi.fn(), forceEvaluate: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  __setDeps({ documentService, approvalService, audit } as unknown as DocumentHandlerDeps);
  return { documentService, approvalService, audit };
}

describe('document-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDeps(null);
  });

  it('401 unauthenticated', async () => {
    mockDeps();
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/documents', anonymous: true }));
    expect(res.statusCode).toBe(401);
  });

  it('403 for non-admin', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/documents', roles: ['revisor'] }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('POST single init returns 201 with upload target', async () => {
    const { documentService } = mockDeps();
    documentService.initUpload.mockResolvedValue({
      documentId: 'd1',
      name: 'g.md',
      uploadUrl: 'https://s3/upload',
      uploadFields: { key: 'documents/d1.md' },
    });
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/documents', body: { name: 'g.md' } }),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body as string);
    expect(body.uploadUrl).toBe('https://s3/upload');
    expect(body.uploadFields).toBeDefined();
  });

  it('POST single init with non-.md name returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/documents', body: { name: 'notes.txt' } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST batch processes each file with per-file result', async () => {
    const { documentService } = mockDeps();
    documentService.initUpload.mockImplementation(async (name: string) => ({
      documentId: `id-${name}`,
      name,
      uploadUrl: 'https://s3/upload',
      uploadFields: {},
    }));
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/documents',
        body: { files: [{ name: 'a.md' }, { name: 'b.md' }] },
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body as string);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe('ok');
  });

  it('POST batch with an invalid file name is rejected by schema (400)', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/documents',
        body: { files: [{ name: 'bad.txt' }] },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST confirm-upload returns the document', async () => {
    const { documentService } = mockDeps();
    documentService.confirmUpload.mockResolvedValue({ id: 'd1', status: 'classifying' });
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/documents/d1/confirm-upload', id: 'd1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(documentService.confirmUpload).toHaveBeenCalledWith('d1', 'admin-1');
  });

  it('GET list', async () => {
    const { documentService } = mockDeps();
    documentService.list.mockResolvedValue([]);
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/documents' }));
    expect(res.statusCode).toBe(200);
  });

  it('GET by id', async () => {
    const { documentService } = mockDeps();
    documentService.get.mockResolvedValue({ id: 'd1' });
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/documents/d1', id: 'd1' }));
    expect(res.statusCode).toBe(200);
    expect(documentService.get).toHaveBeenCalledWith('d1');
  });

  it('PATCH module reassigns and audits', async () => {
    const { documentService, audit } = mockDeps();
    documentService.reassignModule.mockResolvedValue({ id: 'd1', moduleId: 'm1' });
    const res = await handler(
      makeEvent({ method: 'PATCH', path: '/v1/documents/d1/module', id: 'd1', body: { moduleId: 'm1' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(documentService.reassignModule).toHaveBeenCalledWith('d1', 'm1');
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('PATCH approval-policy sets policy', async () => {
    const { documentService } = mockDeps();
    documentService.setApprovalPolicy.mockResolvedValue({ id: 'd1', approvalPolicy: 'any' });
    const res = await handler(
      makeEvent({
        method: 'PATCH',
        path: '/v1/documents/d1/approval-policy',
        id: 'd1',
        body: { approvalPolicy: 'any' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(documentService.setApprovalPolicy).toHaveBeenCalledWith('d1', 'any');
  });

  it('PATCH approval-policy with invalid value returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'PATCH',
        path: '/v1/documents/d1/approval-policy',
        id: 'd1',
        body: { approvalPolicy: 'majority' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('surfaces NotFound from the service as 404', async () => {
    const { documentService } = mockDeps();
    documentService.get.mockRejectedValue(new NotFoundError('Document', 'ghost'));
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/documents/ghost', id: 'ghost' }));
    expect(res.statusCode).toBe(404);
  });

  it('POST force-approval forces evaluation (200)', async () => {
    const { approvalService } = mockDeps();
    approvalService.forceEvaluate.mockResolvedValue({ decision: 'approved', document: { id: 'd1' } });
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/documents/d1/force-approval',
        id: 'd1',
        body: { excludedRecordIds: ['u2'], reason: 'no-show' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(approvalService.forceEvaluate).toHaveBeenCalledWith('d1', ['u2'], 'no-show', 'admin-1');
  });

  it('POST force-approval with invalid body returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/documents/d1/force-approval',
        id: 'd1',
        body: { excludedRecordIds: [], reason: '' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('non-admin cannot force-approval (403)', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/documents/d1/force-approval',
        id: 'd1',
        roles: ['revisor'],
        body: { excludedRecordIds: ['u2'], reason: 'x' },
      }),
    );
    expect(res.statusCode).toBe(403);
  });
});
