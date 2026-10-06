import type { S3Event, SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { getConfig } from '../../../lib/config.js';
import { createDocumentClient } from '../../../repositories/dynamo/client.js';
import { DocumentRepo } from '../../../repositories/dynamo/document-repo.js';
import { ModuleRepo } from '../../../repositories/dynamo/module-repo.js';
import { DocumentStore } from '../../../repositories/s3/document-store.js';
import { SqsQueueSender } from '../../../repositories/sqs/queue-sender.js';
import { SecretsManagerReader } from '../../../providers/secrets.js';
import { createAiProvider } from '../../../providers/ai/factory.js';
import { EventBridgePublisher } from '../../../events/publisher.js';
import { ClassificationService } from '../../../services/classification-service.js';
import { runClassification } from '../../workers/classification-worker.js';

/**
 * Lambda entry point for the Classification Worker.
 * Triggered by S3 ObjectCreated events and SQS retry messages.
 */
export async function handler(event: S3Event | SQSEvent): Promise<SQSBatchResponse> {
  const cfg = getConfig();
  const client = createDocumentClient();
  const documentRepo = new DocumentRepo(client, cfg.tableName);
  const moduleRepo = new ModuleRepo(client, cfg.tableName);
  const documentStore = new DocumentStore(cfg.bucketName, { region: cfg.region });
  const events = new EventBridgePublisher(cfg.region);
  const secrets = new SecretsManagerReader({ region: cfg.region });
  const aiProvider = await createAiProvider(cfg, secrets);

  const classificationService = new ClassificationService({
    documentRepo,
    moduleRepo,
    documentStore,
    aiProvider,
    events,
    config: cfg,
  });

  const schedulingQueue = new SqsQueueSender(cfg.schedulingQueueUrl, { region: cfg.region });

  return runClassification(event, { classificationService, schedulingQueue });
}
