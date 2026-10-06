import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentService } from './document-service.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { DocumentStatus, ClassificationSource } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import type { Document } from '../domain/entities.js';

function makeDeps(opts?: { module?: { id: string; name: string } | null }) {
  const store = new Map<string, Document>();
  const documentRepo = {
    put: vi.fn().mockImplementation(async (d: Document) => {
      store.set(d.id, d);
      return d;
    }),
    get: vi.fn().mockImplementation(async (id: string) => store.get(id) ?? null),
    list: vi.fn().mockImplementation(async () => [...store.values()]),
    update: vi.fn().mockImplementation(async (d: Document) => {
      store.set(d.id, d);
      return d;
    }),
    updateStatus: vi.fn(),
  };
  const moduleRepo = {
    get: vi.fn().mockResolvedValue(
      opts && 'module' in opts ? opts.module : { id: 'm1', name: 'ventas' },
    ),
  };
  const documentStore = {
    buildKey: vi.fn().mockImplementation((id: string) => `documents/${id}.md`),
    createUpload: vi.fn().mockResolvedValue({
      key: 'documents/x.md',
      url: 'https://s3.example/upload',
      fields: { key: 'documents/x.md', 'Content-Type': 'text/markdown' },
    }),
  };
  const events = new FakeEventPublisher();
  const config = { defaultApprovalPolicy: 'all' as const, maxUploadSizeBytes: 5 * 1024 * 1024 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { documentRepo, moduleRepo, documentStore, events, config, store } as any;
}

describe('DocumentService.initUpload', () => {
  it('creates pending_content metadata with default approval policy and returns presigned POST', async () => {
    const deps = makeDeps();
    const svc = new DocumentService(deps);
    const result = await svc.initUpload('guide.md');

    expect(result.documentId).toBeTypeOf('string');
    expect(result.uploadUrl).toBe('https://s3.example/upload');
    expect(result.uploadFields['Content-Type']).toBe('text/markdown');

    const stored = deps.store.get(result.documentId);
    expect(stored.status).toBe(DocumentStatus.PENDING_CONTENT);
    expect(stored.approvalPolicy).toBe('all');
    expect(stored.name).toBe('guide.md');
  });

  it('passes the configured max size to the upload presigner (R4.2)', async () => {
    const deps = makeDeps();
    await new DocumentService(deps).initUpload('g.md');
    expect(deps.documentStore.createUpload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxBytes: 5 * 1024 * 1024 }),
    );
  });
});

describe('DocumentService.confirmUpload', () => {
  let deps: ReturnType<typeof makeDeps>;
  let docId: string;

  beforeEach(async () => {
    deps = makeDeps();
    const r = await new DocumentService(deps).initUpload('g.md');
    docId = r.documentId;
    (deps.events as FakeEventPublisher).clear();
  });

  it('transitions pending_content -> classifying and publishes DOCUMENT_UPLOADED', async () => {
    const svc = new DocumentService(deps);
    const doc = await svc.confirmUpload(docId, 'admin-1');
    expect(doc.status).toBe(DocumentStatus.CLASSIFYING);

    const events = (deps.events as FakeEventPublisher).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(SystemEventType.DOCUMENT_UPLOADED);
    expect(events[0]!.actor).toBe('admin-1');
  });

  it('is idempotent: second confirm does not re-publish', async () => {
    const svc = new DocumentService(deps);
    await svc.confirmUpload(docId);
    (deps.events as FakeEventPublisher).clear();
    const doc = await svc.confirmUpload(docId);
    expect(doc.status).toBe(DocumentStatus.CLASSIFYING);
    expect((deps.events as FakeEventPublisher).events).toHaveLength(0);
  });

  it('throws NotFound for unknown document', async () => {
    await expect(new DocumentService(deps).confirmUpload('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('DocumentService.reassignModule', () => {
  it('sets module, source=manual, status classified', async () => {
    const deps = makeDeps();
    const svc = new DocumentService(deps);
    const r = await svc.initUpload('g.md');
    const doc = await svc.reassignModule(r.documentId, 'm1');
    expect(doc.moduleId).toBe('m1');
    expect(doc.classification?.source).toBe(ClassificationSource.MANUAL);
    expect(doc.status).toBe(DocumentStatus.CLASSIFIED);
  });

  it('throws NotFound when the module does not exist', async () => {
    const deps = makeDeps({ module: null });
    const svc = new DocumentService(deps);
    const r = await svc.initUpload('g.md');
    await expect(svc.reassignModule(r.documentId, 'ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DocumentService.setApprovalPolicy', () => {
  it('updates the policy', async () => {
    const deps = makeDeps();
    const svc = new DocumentService(deps);
    const r = await svc.initUpload('g.md');
    const doc = await svc.setApprovalPolicy(r.documentId, 'any');
    expect(doc.approvalPolicy).toBe('any');
  });

  it('rejects changing policy after a decision (409)', async () => {
    const deps = makeDeps();
    const svc = new DocumentService(deps);
    const r = await svc.initUpload('g.md');
    const stored = deps.store.get(r.documentId)!;
    deps.store.set(r.documentId, { ...stored, status: DocumentStatus.APPROVED });
    await expect(svc.setApprovalPolicy(r.documentId, 'any')).rejects.toBeInstanceOf(ConflictError);
  });
});
