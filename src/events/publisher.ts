import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { logger } from '../lib/logger.js';
import type { SystemEvent } from './types.js';

const EVENT_SOURCE = 'oli-docs';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Publishes system events. Implementations must be fire-and-forget:
 * failures are logged but never propagate to the caller (R13.3, R13.4).
 */
export interface EventPublisher {
  publish(event: SystemEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// EventBridge implementation
// ---------------------------------------------------------------------------

export class EventBridgePublisher implements EventPublisher {
  private readonly client: EventBridgeClient;

  constructor(region?: string) {
    this.client = new EventBridgeClient({ region });
  }

  async publish(event: SystemEvent): Promise<void> {
    try {
      const result = await this.client.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: EVENT_SOURCE,
              DetailType: event.type,
              Detail: JSON.stringify({
                resourceId: event.resourceId,
                timestamp: event.timestamp,
                actor: event.actor,
                ...event.detail,
              }),
            },
          ],
        }),
      );

      // PutEvents can return HTTP 200 while still reporting per-entry
      // failures. Surface those instead of assuming success (R13.4).
      if ((result.FailedEntryCount ?? 0) > 0) {
        const failed = (result.Entries ?? []).filter((e) => e.ErrorCode);
        logger.error('Event partially failed to publish', {
          eventType: event.type,
          resourceId: event.resourceId,
          failedEntryCount: result.FailedEntryCount,
          errors: failed.map((e) => ({ code: e.ErrorCode, message: e.ErrorMessage })),
        });
        return;
      }

      logger.debug('Event published', { eventType: event.type, resourceId: event.resourceId });
    } catch (err) {
      // Fire-and-forget: log the failure, never throw (R13.4).
      logger.error('Failed to publish event', {
        eventType: event.type,
        resourceId: event.resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Fake implementation for tests
// ---------------------------------------------------------------------------

export class FakeEventPublisher implements EventPublisher {
  public readonly events: SystemEvent[] = [];
  public shouldFail = false;

  async publish(event: SystemEvent): Promise<void> {
    if (this.shouldFail) {
      // Simulates a failure — should still not throw per contract.
      logger.error('FakeEventPublisher: simulated failure', {
        eventType: event.type,
      });
      return;
    }
    this.events.push(event);
  }

  /** Reset recorded events. */
  clear(): void {
    this.events.length = 0;
    this.shouldFail = false;
  }
}
