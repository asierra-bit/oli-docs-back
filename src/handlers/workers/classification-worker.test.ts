import { describe, it, expect, vi } from 'vitest';
import type { S3Event, SQSEvent } from 'aws-lambda';
import { extractDocumentIds, runClassification } from './classification-worker.js';
import { DocumentStatus } from '../../domain/enums.js';

function s3Event(keys: string[]): S3Event {
  return {
    Records: keys.map((key) => ({
      eventSource: 'aws:s3',
      s3: { object: { key } },
    })),
  } as unknown as S3Event;
}

function sqsEvent(bodies: unknown[]): SQSEvent {
  return {
    Records: bodies.map((b, i) => ({
      eventSource: 'aws:sqs',
      messageId: `m${i}`,
      body: typeof b === 'string' ? b : JSON.stringify(b),
    })),
  } as unknown as SQSEvent;
}

describe('extractDocumentIds', () => {
  it('parses docIds from S3 ObjectCreated keys', () => {
    const ids = extractDocumentIds(s3Event(['documents/d1.md', 'documents/d2.md']));
    expect(ids).toEqual(['d1', 'd2']);
  });

  it('handles URL-encoded S3 keys', () => {
    const ids = extractDocumentIds(s3Event(['documents%2Fd3.md']));
    expect(ids).toEqual(['d3']);
  });

  it('skips S3 keys that are not document content keys', () => {
    const ids = extractDocumentIds(s3Event(['other/thing.txt', 'documents/d1.md']));
    expect(ids).toEqual(['d1']);
  });

  it('parses docIds from SQS retry messages', () => {
    const ids = extractDocumentIds(sqsEvent([{ documentId: 'd9' }]));
    expect(ids).toEqual(['d9']);
  });

  it('skips unparseable SQS messages', () => {
    const ids = extractDocumentIds(sqsEvent(['not json', { documentId: 'd7' }]));
    expect(ids).toEqual(['d7']);
  });
});

describe('runClassification', () => {
  function makeDeps(status: DocumentStatus, classifiedNow = status === DocumentStatus.CLASSIFIED) {
    return {
      classificationService: {
        classify: vi.fn().mockResolvedValue({ status, classifiedNow }),
      },
      schedulingQueue: { send: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('enqueues scheduling when a document becomes classified', async () => {
    const deps = makeDeps(DocumentStatus.CLASSIFIED);
    const res = await runClassification(s3Event(['documents/d1.md']), deps);
    expect(deps.classificationService.classify).toHaveBeenCalledWith('d1');
    expect(deps.schedulingQueue.send).toHaveBeenCalledWith({ documentId: 'd1' });
    expect(res.batchItemFailures).toEqual([]);
  });

  it('does NOT re-enqueue for an already-classified doc (classifiedNow=false)', async () => {
    const deps = makeDeps(DocumentStatus.CLASSIFIED, false);
    await runClassification(sqsEvent([{ documentId: 'dup' }]), deps);
    expect(deps.schedulingQueue.send).not.toHaveBeenCalled();
  });

  it('does not enqueue when needs_manual_classification', async () => {
    const deps = makeDeps(DocumentStatus.NEEDS_MANUAL_CLASSIFICATION);
    await runClassification(s3Event(['documents/d1.md']), deps);
    expect(deps.schedulingQueue.send).not.toHaveBeenCalled();
  });

  it('does not enqueue when classification_failed', async () => {
    const deps = makeDeps(DocumentStatus.CLASSIFICATION_FAILED);
    await runClassification(s3Event(['documents/d1.md']), deps);
    expect(deps.schedulingQueue.send).not.toHaveBeenCalled();
  });

  it('processes multiple documents', async () => {
    const deps = makeDeps(DocumentStatus.CLASSIFIED);
    await runClassification(s3Event(['documents/d1.md', 'documents/d2.md']), deps);
    expect(deps.classificationService.classify).toHaveBeenCalledTimes(2);
    expect(deps.schedulingQueue.send).toHaveBeenCalledTimes(2);
  });

  it('works from an SQS retry trigger too', async () => {
    const deps = makeDeps(DocumentStatus.CLASSIFIED);
    await runClassification(sqsEvent([{ documentId: 'retry-1' }]), deps);
    expect(deps.classificationService.classify).toHaveBeenCalledWith('retry-1');
    expect(deps.schedulingQueue.send).toHaveBeenCalledWith({ documentId: 'retry-1' });
  });

  it('isolates a failing SQS item as a partial batch failure', async () => {
    const deps = {
      classificationService: {
        classify: vi
          .fn()
          .mockResolvedValueOnce({ status: DocumentStatus.CLASSIFIED, classifiedNow: true })
          .mockRejectedValueOnce(new Error('boom')),
      },
      schedulingQueue: { send: vi.fn().mockResolvedValue(undefined) },
    };
    const res = await runClassification(
      sqsEvent([{ documentId: 'ok-1' }, { documentId: 'bad-1' }]),
      deps,
    );
    // The good item still enqueued; only the bad message is reported for retry.
    expect(deps.schedulingQueue.send).toHaveBeenCalledWith({ documentId: 'ok-1' });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('rethrows when an S3-triggered item fails (no partial retry channel)', async () => {
    const deps = {
      classificationService: {
        classify: vi.fn().mockRejectedValue(new Error('s3 read failed')),
      },
      schedulingQueue: { send: vi.fn() },
    };
    await expect(
      runClassification(s3Event(['documents/d1.md']), deps),
    ).rejects.toThrow('s3 read failed');
  });
});
