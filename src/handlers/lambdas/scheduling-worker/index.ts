import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { getConfig } from '../../../lib/config.js';
import { createDocumentClient } from '../../../repositories/dynamo/client.js';
import { DocumentRepo } from '../../../repositories/dynamo/document-repo.js';
import { AssignmentRepo } from '../../../repositories/dynamo/assignment-repo.js';
import { ReviewRecordRepo } from '../../../repositories/dynamo/review-record-repo.js';
import { DocumentStore } from '../../../repositories/s3/document-store.js';
import { SecretsManagerReader } from '../../../providers/secrets.js';
import { GoogleOAuth } from '../../../providers/calendar/google-oauth.js';
import { GoogleCalendarProvider } from '../../../providers/calendar/google-calendar-provider.js';
import { SecretsOAuthTokenStore } from '../../../providers/calendar/token-store.js';
import { EventBridgePublisher } from '../../../events/publisher.js';
import { SchedulingService } from '../../../services/scheduling-service.js';
import { runScheduling } from '../../workers/scheduling-worker.js';

/**
 * Lambda entry point for the Scheduling Worker (SQS-triggered).
 * The event source mapping must enable ReportBatchItemFailures so the returned
 * batchItemFailures are honoured.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const cfg = getConfig();
  const client = createDocumentClient();
  const documentRepo = new DocumentRepo(client, cfg.tableName);
  const assignmentRepo = new AssignmentRepo(client, cfg.tableName);
  const reviewRecordRepo = new ReviewRecordRepo(client, cfg.tableName);
  const documentStore = new DocumentStore(cfg.bucketName, { region: cfg.region });
  const events = new EventBridgePublisher(cfg.region);

  const secrets = new SecretsManagerReader({ region: cfg.region });
  const clientSecret = cfg.googleClientSecretId
    ? await secrets.getSecret(cfg.googleClientSecretId)
    : '';
  const oauth = new GoogleOAuth({
    clientId: cfg.googleClientId,
    clientSecret,
    redirectUri: cfg.googleRedirectUri,
  });
  const tokenStore = new SecretsOAuthTokenStore('oli-docs/google-oauth', { region: cfg.region });
  const calendar = new GoogleCalendarProvider(oauth, tokenStore);

  const schedulingService = new SchedulingService({
    documentRepo,
    assignmentRepo,
    reviewRecordRepo,
    documentStore,
    calendar,
    events,
    config: cfg,
  });

  return runScheduling(event, { schedulingService });
}
