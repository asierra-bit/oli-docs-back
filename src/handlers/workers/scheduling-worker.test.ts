import { describe, it, expect, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { runScheduling } from './scheduling-worker.js';

function sqsEvent(records: { id: string; body: unknown }[]): SQSEvent {
  return {
    Records: records.map((r) => ({
      messageId: r.id,
      body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    })),
  } as unknown as SQSEvent;
}

describe('runScheduling', () => {
  it('invokes scheduleFor for each message and reports no failures on success', async () => {
    const schedulingService = { scheduleFor: vi.fn().mockResolvedValue([]) };
    const res = await runScheduling(
      sqsEvent([
        { id: 'm1', body: { documentId: 'd1' } },
        { id: 'm2', body: { documentId: 'd2' } },
      ]),
      { schedulingService },
    );
    expect(schedulingService.scheduleFor).toHaveBeenCalledWith('d1');
    expect(schedulingService.scheduleFor).toHaveBeenCalledWith('d2');
    expect(res.batchItemFailures).toEqual([]);
  });

  it('reports only the failed message in batchItemFailures', async () => {
    const schedulingService = {
      scheduleFor: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'bad') throw new Error('boom');
        return [];
      }),
    };
    const res = await runScheduling(
      sqsEvent([
        { id: 'm1', body: { documentId: 'ok' } },
        { id: 'm2', body: { documentId: 'bad' } },
      ]),
      { schedulingService },
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });

  it('drops unparseable messages without failing the batch', async () => {
    const schedulingService = { scheduleFor: vi.fn() };
    const res = await runScheduling(sqsEvent([{ id: 'm1', body: 'not json' }]), {
      schedulingService,
    });
    expect(schedulingService.scheduleFor).not.toHaveBeenCalled();
    expect(res.batchItemFailures).toEqual([]);
  });

  it('drops messages missing documentId', async () => {
    const schedulingService = { scheduleFor: vi.fn() };
    const res = await runScheduling(sqsEvent([{ id: 'm1', body: { foo: 'bar' } }]), {
      schedulingService,
    });
    expect(schedulingService.scheduleFor).not.toHaveBeenCalled();
    expect(res.batchItemFailures).toEqual([]);
  });
});
