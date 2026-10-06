import { getConfig } from '../../../lib/config.js';
import { createDocumentClient } from '../../../repositories/dynamo/client.js';
import { ReviewRecordRepo } from '../../../repositories/dynamo/review-record-repo.js';
import { EventBridgePublisher } from '../../../events/publisher.js';
import { ReviewTimeoutService } from '../../../services/review-timeout-service.js';

/**
 * Lambda entry point for the Review Timeout Checker.
 * Triggered by an EventBridge scheduled rule (daily). Idempotent — it only
 * publishes events and never mutates state (R9.9).
 */
export async function handler(): Promise<{ expiredCount: number }> {
  const cfg = getConfig();
  const client = createDocumentClient();
  const reviewRecordRepo = new ReviewRecordRepo(client, cfg.tableName);
  const events = new EventBridgePublisher(cfg.region);

  const service = new ReviewTimeoutService({ reviewRecordRepo, events, config: cfg });
  const expired = await service.checkExpiredReviews();
  return { expiredCount: expired.length };
}
