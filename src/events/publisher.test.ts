import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeEventPublisher } from './publisher.js';
import type { SystemEvent } from './types.js';
import { SystemEventType } from './types.js';

describe('FakeEventPublisher', () => {
  let publisher: FakeEventPublisher;

  const sampleEvent: SystemEvent = {
    type: SystemEventType.DOCUMENT_UPLOADED,
    resourceId: 'doc-123',
    timestamp: '2026-01-01T00:00:00.000Z',
    actor: 'admin-1',
  };

  beforeEach(() => {
    publisher = new FakeEventPublisher();
  });

  it('records published events', async () => {
    await publisher.publish(sampleEvent);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toEqual(sampleEvent);
  });

  it('records multiple events', async () => {
    await publisher.publish(sampleEvent);
    await publisher.publish({ ...sampleEvent, type: SystemEventType.DOCUMENT_CLASSIFIED });
    expect(publisher.events).toHaveLength(2);
    expect(publisher.events[1]!.type).toBe(SystemEventType.DOCUMENT_CLASSIFIED);
  });

  it('does not record events when shouldFail is true (fire-and-forget)', async () => {
    publisher.shouldFail = true;
    // Should not throw — fire-and-forget contract
    await expect(publisher.publish(sampleEvent)).resolves.toBeUndefined();
    expect(publisher.events).toHaveLength(0);
  });

  it('clear() resets state', async () => {
    await publisher.publish(sampleEvent);
    publisher.shouldFail = true;
    publisher.clear();
    expect(publisher.events).toHaveLength(0);
    expect(publisher.shouldFail).toBe(false);
  });
});

describe('EventBridgePublisher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when EventBridge send fails (fire-and-forget)', async () => {
    // We mock the AWS SDK to simulate failure
    vi.mock('@aws-sdk/client-eventbridge', () => {
      const PutEventsCommand = vi.fn();
      const EventBridgeClient = vi.fn().mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error('network error')),
      }));
      return { EventBridgeClient, PutEventsCommand };
    });

    // Re-import to get the mocked version
    const { EventBridgePublisher } = await import('./publisher.js');
    const publisher = new EventBridgePublisher();

    const event: SystemEvent = {
      type: SystemEventType.DOCUMENT_APPROVED,
      resourceId: 'doc-1',
      timestamp: new Date().toISOString(),
    };

    // Must not throw
    await expect(publisher.publish(event)).resolves.toBeUndefined();
  });
});
