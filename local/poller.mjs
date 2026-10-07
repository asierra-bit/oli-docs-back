#!/usr/bin/env node
/**
 * Local worker poller — hace que el entorno local se sienta como producción.
 *
 * En AWS, cargar un documento dispara los workers solos (S3 ObjectCreated →
 * clasificación → SQS → agendado). En local no hay esos triggers, así que este
 * poller los emula en bucle:
 *
 *   cada TICK:
 *     1. busca documentos en estado `classifying` (recién confirmados por la
 *        carga) y los pasa por el worker de clasificación — que, al clasificar,
 *        encola un mensaje de agendado en SQS (igual que en prod).
 *     2. drena la cola de agendado y corre el worker de agendado, que crea una
 *        revisión por revisor y reserva el bloque en su Calendar (fake).
 *
 * Resultado: subes un .md en la UI y, en un par de segundos, aparece
 * clasificado y con sus revisiones agendadas, sin tocar nada. Como en AWS.
 *
 * Run (con el stack arriba y las env cargadas):
 *   export $(grep -v '^#' local/.env.local | xargs)
 *   npx tsx local/poller.mjs
 *
 * IA y Calendar son los fakes del repo; nada toca AWS.
 */

import { S3Client } from '@aws-sdk/client-s3';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { createDocumentClient } from '../src/repositories/dynamo/client.ts';
import { DocumentRepo } from '../src/repositories/dynamo/document-repo.ts';
import { ModuleRepo } from '../src/repositories/dynamo/module-repo.ts';
import { AssignmentRepo } from '../src/repositories/dynamo/assignment-repo.ts';
import { ReviewRecordRepo } from '../src/repositories/dynamo/review-record-repo.ts';
import { DocumentStore } from '../src/repositories/s3/document-store.ts';
import { SqsQueueSender } from '../src/repositories/sqs/queue-sender.ts';
import { ClassificationService } from '../src/services/classification-service.ts';
import { SchedulingService } from '../src/services/scheduling-service.ts';
import { runClassification } from '../src/handlers/workers/classification-worker.ts';
import { runScheduling } from '../src/handlers/workers/scheduling-worker.ts';
import { FakeAiProvider } from '../src/providers/ai/fake-ai-provider.ts';
import { FakeCalendarProvider } from '../src/providers/calendar/fake-calendar-provider.ts';
import { DocumentStatus } from '../src/domain/enums.ts';
import { getConfig } from '../src/lib/config.ts';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const BUCKET = process.env.BUCKET_NAME ?? 'oli-docs-local';
const SCHEDULING_QUEUE_URL =
  process.env.SCHEDULING_QUEUE_URL ??
  'http://localhost:4566/000000000000/oli-scheduling-queue';
const TICK_MS = Number(process.env.POLLER_TICK_MS ?? 2000);
const creds = { accessKeyId: 'local', secretAccessKey: 'local' };

const cfg = getConfig();

const ddb = createDocumentClient();
const s3 = new S3Client({
  region: REGION,
  endpoint: AWS_ENDPOINT,
  credentials: creds,
  forcePathStyle: true,
});
const sqs = new SQSClient({ region: REGION, endpoint: AWS_ENDPOINT, credentials: creds });

const documentRepo = new DocumentRepo(ddb, cfg.tableName);
const moduleRepo = new ModuleRepo(ddb, cfg.tableName);
const assignmentRepo = new AssignmentRepo(ddb, cfg.tableName);
const reviewRecordRepo = new ReviewRecordRepo(ddb, cfg.tableName);
const documentStore = new DocumentStore(BUCKET, { client: s3 });
const schedulingQueue = new SqsQueueSender(SCHEDULING_QUEUE_URL, { client: sqs });

// EventBridge no se emula; publisher no-op para no bloquear el flujo.
const events = { publish: async () => {} };

const classificationService = new ClassificationService({
  documentRepo,
  moduleRepo,
  documentStore,
  aiProvider: new FakeAiProvider(),
  events,
  config: cfg,
});

const schedulingService = new SchedulingService({
  documentRepo,
  assignmentRepo,
  reviewRecordRepo,
  documentStore,
  calendar: new FakeCalendarProvider(),
  events,
  config: cfg,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paso 1: clasificar los documentos que estén esperando (status classifying). */
async function classifyPending() {
  let docs;
  try {
    docs = await documentRepo.list();
  } catch (err) {
    console.error('  ! no se pudo listar documentos:', err?.message ?? err);
    return;
  }
  const pending = docs.filter((d) => d.status === DocumentStatus.CLASSIFYING);
  for (const doc of pending) {
    // Reusar el worker por la vía SQS ({ documentId }) para preservar su
    // lógica: clasifica y, si queda `classified`, encola el agendado.
    const event = {
      Records: [
        {
          eventSource: 'aws:sqs',
          messageId: `poller-${doc.id}-${Date.now()}`,
          body: JSON.stringify({ documentId: doc.id }),
        },
      ],
    };
    try {
      await runClassification(event, { classificationService, schedulingQueue });
      const after = await documentRepo.get(doc.id);
      console.log(`  · clasificado ${doc.id} → ${after?.status}`);
    } catch (err) {
      console.error(`  ! fallo al clasificar ${doc.id}:`, err?.message ?? err);
    }
  }
}

/** Paso 2: drenar la cola de agendado y correr el worker de agendado. */
async function drainScheduling() {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: SCHEDULING_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }),
  );
  const messages = received.Messages ?? [];
  if (messages.length === 0) return;

  const event = {
    Records: messages.map((m) => ({
      messageId: m.MessageId,
      body: m.Body,
      eventSource: 'aws:sqs',
    })),
  };
  try {
    await runScheduling(event, { schedulingService });
    for (const m of messages) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: SCHEDULING_QUEUE_URL,
          ReceiptHandle: m.ReceiptHandle,
        }),
      );
    }
    console.log(`  · agendadas ${messages.length} revisión(es)`);
  } catch (err) {
    console.error('  ! fallo al agendar:', err?.message ?? err);
  }
}

let running = true;
process.on('SIGINT', () => {
  console.log('\nDeteniendo poller…');
  running = false;
});

async function main() {
  console.log(`Oli's Docs — poller local (cada ${TICK_MS}ms)`);
  console.log(`  DynamoDB: ${process.env.DYNAMODB_ENDPOINT ?? '(default)'}`);
  console.log(`  AWS (S3/SQS): ${AWS_ENDPOINT}`);
  console.log('  Esperando documentos cargados… (Ctrl-C para parar)\n');

  while (running) {
    await classifyPending();
    await drainScheduling();
    await sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error('Poller abortado:', err);
  process.exit(1);
});
