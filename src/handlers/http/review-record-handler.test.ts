import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler, __setDeps } from './review-record-handler.js';
import { ForbiddenError } from '../../lib/errors.js';
import type { ReviewRecordService } from '../../services/review-record-service.js';

function makeEvent(opts: {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  id?: string;
  sectionId?: string;
  body?: unknown;
  roles?: string[];
  anonymous?: boolean;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims = opts.anonymous
    ? undefined
    : { sub: 'u1', 'cognito:groups': opts.roles ?? ['revisor'] };
  const pathParameters: Record<string, string> = {};
  if (opts.id) pathParameters.id = opts.id;
  if (opts.sectionId) pathParameters.sectionId = opts.sectionId;
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
  const service = {
    listMine: vi.fn(),
    get: vi.fn(),
    addAnnotation: vi.fn(),
    setSectionVerdict: vi.fn(),
    setDocumentVerdict: vi.fn(),
    submit: vi.fn(),
    reopen: vi.fn(),
  };
  __setDeps({ service: service as unknown as ReviewRecordService });
  return { service };
}

describe('review-record-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDeps(null);
  });

  it('401 when unauthenticated', async () => {
    mockDeps();
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/reviews/mine', anonymous: true }));
    expect(res.statusCode).toBe(401);
  });

  it('GET /reviews/mine lists records', async () => {
    const { service } = mockDeps();
    service.listMine.mockResolvedValue([]);
    const res = await handler(makeEvent({ method: 'GET', path: '/v1/reviews/mine' }));
    expect(res.statusCode).toBe(200);
    expect(service.listMine).toHaveBeenCalled();
  });

  it('GET /review-records/{id} returns detail', async () => {
    const { service } = mockDeps();
    service.get.mockResolvedValue({ record: {}, annotations: [], sectionVerdicts: [] });
    const res = await handler(
      makeEvent({ method: 'GET', path: '/v1/review-records/d1%23u1', id: 'd1#u1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith(expect.anything(), 'd1#u1');
  });

  it('POST annotation returns 201', async () => {
    const { service } = mockDeps();
    service.addAnnotation.mockResolvedValue({ id: 'a1' });
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/review-records/d1#u1/annotations',
        id: 'd1#u1',
        body: { target: { type: 'document' }, text: 'ok' },
      }),
    );
    expect(res.statusCode).toBe(201);
  });

  it('POST annotation with invalid body returns 400', async () => {
    mockDeps();
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/v1/review-records/d1#u1/annotations',
        id: 'd1#u1',
        body: { target: { type: 'document' }, text: '' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('PUT section verdict', async () => {
    const { service } = mockDeps();
    service.setSectionVerdict.mockResolvedValue({ verdict: 'correct' });
    const res = await handler(
      makeEvent({
        method: 'PUT',
        path: '/v1/review-records/d1#u1/sections/s1/verdict',
        id: 'd1#u1',
        sectionId: 's1',
        body: { verdict: 'correct' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(service.setSectionVerdict).toHaveBeenCalledWith(expect.anything(), 'd1#u1', 's1', 'correct');
  });

  it('PUT document verdict', async () => {
    const { service } = mockDeps();
    service.setDocumentVerdict.mockResolvedValue({ documentVerdict: 'incorrect' });
    const res = await handler(
      makeEvent({
        method: 'PUT',
        path: '/v1/review-records/d1#u1/document-verdict',
        id: 'd1#u1',
        body: { verdict: 'incorrect' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(service.setDocumentVerdict).toHaveBeenCalledWith(expect.anything(), 'd1#u1', 'incorrect');
  });

  it('POST submit', async () => {
    const { service } = mockDeps();
    service.submit.mockResolvedValue({ status: 'completed' });
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/review-records/d1#u1/submit', id: 'd1#u1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(service.submit).toHaveBeenCalledWith(expect.anything(), 'd1#u1');
  });

  it('POST reopen surfaces Forbidden as 403', async () => {
    const { service } = mockDeps();
    service.reopen.mockRejectedValue(new ForbiddenError('admin only'));
    const res = await handler(
      makeEvent({ method: 'POST', path: '/v1/review-records/d1#u1/reopen', id: 'd1#u1' }),
    );
    expect(res.statusCode).toBe(403);
  });
});
