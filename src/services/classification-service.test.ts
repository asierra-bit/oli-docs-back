import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClassificationService } from './classification-service.js';
import { NotFoundError } from '../lib/errors.js';
import { DocumentStatus, ClassificationSource } from '../domain/enums.js';
import { SystemEventType } from '../events/types.js';
import { FakeEventPublisher } from '../events/publisher.js';
import { FakeAiProvider } from '../providers/ai/fake-ai-provider.js';
import type { Document } from '../domain/entities.js';

function baseDoc(): Document {
  return {
    id: 'd1',
    name: 'g.md',
    s3Key: 'documents/d1.md',
    status: DocumentStatus.CLASSIFYING,
    approvalPolicy: 'all',
    createdAt: 'now',
  };
}

function makeDeps(opts?: { threshold?: number; maxAttempts?: number; content?: string }) {
  const doc = baseDoc();
  const documentRepo = {
    get: vi.fn().mockResolvedValue(doc),
    update: vi.fn().mockImplementation(async (d: Document) => d),
  };
  const moduleRepo = {
    list: vi.fn().mockResolvedValue([
      { id: 'm1', name: 'ventas', createdAt: 'now' },
      { id: 'm2', name: 'marca', createdAt: 'now' },
    ]),
  };
  const documentStore = {
    readContent: vi.fn().mockResolvedValue(opts?.content ?? 'guia de ventas'),
  };
  const aiProvider = new FakeAiProvider();
  const events = new FakeEventPublisher();
  const config = {
    aiConfidenceThreshold: opts?.threshold ?? 0.7,
    aiMaxAttempts: opts?.maxAttempts ?? 3,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { documentRepo, moduleRepo, documentStore, aiProvider, events, config, doc } as any;
}

describe('ClassificationService.classify', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('classifies with high confidence → classified + event', async () => {
    deps.aiProvider.setResult({ moduleId: 'm1', confidence: 0.9 });
    const out = await new ClassificationService(deps).classify('d1');

    expect(out.status).toBe(DocumentStatus.CLASSIFIED);
    expect(out.moduleId).toBe('m1');

    const saved = deps.documentRepo.update.mock.calls.at(-1)![0];
    expect(saved.moduleId).toBe('m1');
    expect(saved.classification.source).toBe(ClassificationSource.AI);
    expect(saved.status).toBe(DocumentStatus.CLASSIFIED);

    const events = (deps.events as FakeEventPublisher).events;
    expect(events[0]!.type).toBe(SystemEventType.DOCUMENT_CLASSIFIED);
  });

  it('low confidence → needs_manual_classification + event', async () => {
    deps.aiProvider.setResult({ moduleId: 'm1', confidence: 0.3 });
    const out = await new ClassificationService(deps).classify('d1');
    expect(out.status).toBe(DocumentStatus.NEEDS_MANUAL_CLASSIFICATION);

    const events = (deps.events as FakeEventPublisher).events;
    expect(events[0]!.type).toBe(SystemEventType.DOCUMENT_NEEDS_MANUAL_CLASSIFICATION);
  });

  it('null module → needs_manual_classification regardless of confidence', async () => {
    deps.aiProvider.setResult({ moduleId: null, confidence: 0.99 });
    const out = await new ClassificationService(deps).classify('d1');
    expect(out.status).toBe(DocumentStatus.NEEDS_MANUAL_CLASSIFICATION);
  });

  it('provider failing all retries → classification_failed, no classified event', async () => {
    deps.aiProvider.setImpl(() => {
      throw new Error('boom');
    });
    const out = await new ClassificationService(deps).classify('d1');
    expect(out.status).toBe(DocumentStatus.CLASSIFICATION_FAILED);

    const saved = deps.documentRepo.update.mock.calls.at(-1)![0];
    expect(saved.status).toBe(DocumentStatus.CLASSIFICATION_FAILED);

    const events = (deps.events as FakeEventPublisher).events;
    expect(events).toHaveLength(0);
  });

  it('retries then succeeds on a later attempt', async () => {
    let attempts = 0;
    deps.aiProvider.setImpl(() => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return { moduleId: 'm1', confidence: 0.9 };
    });
    const out = await new ClassificationService(deps).classify('d1');
    expect(out.status).toBe(DocumentStatus.CLASSIFIED);
    expect(attempts).toBe(2);
  });

  it('throws NotFound for unknown document', async () => {
    deps.documentRepo.get.mockResolvedValue(null);
    await expect(new ClassificationService(deps).classify('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('confidence exactly at threshold is treated as confident', async () => {
    deps = makeDeps({ threshold: 0.7 });
    deps.aiProvider.setResult({ moduleId: 'm1', confidence: 0.7 });
    const out = await new ClassificationService(deps).classify('d1');
    expect(out.status).toBe(DocumentStatus.CLASSIFIED);
    expect(out.classifiedNow).toBe(true);
  });

  it('is idempotent: an already-classified doc is skipped (no AI call, no event)', async () => {
    deps.documentRepo.get.mockResolvedValue({
      id: 'd1',
      name: 'g.md',
      s3Key: 'documents/d1.md',
      status: DocumentStatus.CLASSIFIED,
      moduleId: 'm1',
      classification: { source: ClassificationSource.AI, confidence: 0.9 },
      approvalPolicy: 'all',
      createdAt: 'now',
    });
    const spy = vi.spyOn(deps.aiProvider, 'classifyDocument');
    const out = await new ClassificationService(deps).classify('d1');

    expect(out.status).toBe(DocumentStatus.CLASSIFIED);
    expect(out.classifiedNow).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(deps.documentRepo.update).not.toHaveBeenCalled();
    expect((deps.events as FakeEventPublisher).events).toHaveLength(0);
  });
});
