#!/usr/bin/env node
/**
 * End-to-end seed for the local stack. Drives the WHOLE documentation flow
 * offline, chaining the two workers through the real local SQS queue:
 *
 *   1. create modules ("skills": pagos, control-escolar, ventas)
 *   2. create reviewers + assignments (Alan ↔ pagos, control-escolar, ventas)
 *   3. initUpload a .md  → PUT its content to local S3
 *   4. confirmUpload     → document leaves pending_content
 *   5. runClassification → FakeAiProvider classifies by name-match,
 *                          enqueues a scheduling message to local SQS
 *   6. drain the scheduling queue → runScheduling → FakeCalendarProvider
 *                          books a block and creates one ReviewRecord per reviewer
 *   7. print GET /reviews/mine for the reviewer
 *
 * Run (after `docker compose -f local/docker-compose.yml up -d`):
 *   export $(grep -v '^#' local/.env.local | xargs)
 *   npx tsx local/seed.mjs
 *
 * Nothing touches AWS. IA and Calendar are the in-repo fakes; identity is not
 * needed here because the seed calls the services/workers directly.
 */

import { ulid } from 'ulid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { createDocumentClient } from '../src/repositories/dynamo/client.ts';
import { ModuleRepo } from '../src/repositories/dynamo/module-repo.ts';
import { ReviewerRepo } from '../src/repositories/dynamo/reviewer-repo.ts';
import { AssignmentRepo } from '../src/repositories/dynamo/assignment-repo.ts';
import { ReviewRecordRepo } from '../src/repositories/dynamo/review-record-repo.ts';
import { DocumentRepo } from '../src/repositories/dynamo/document-repo.ts';
import { DocumentStore } from '../src/repositories/s3/document-store.ts';
import { SqsQueueSender } from '../src/repositories/sqs/queue-sender.ts';
import { ClassificationService } from '../src/services/classification-service.ts';
import { SchedulingService } from '../src/services/scheduling-service.ts';
import { DocumentService } from '../src/services/document-service.ts';
import { runClassification } from '../src/handlers/workers/classification-worker.ts';
import { runScheduling } from '../src/handlers/workers/scheduling-worker.ts';
import { FakeAiProvider } from '../src/providers/ai/fake-ai-provider.ts';
import { FakeCalendarProvider } from '../src/providers/calendar/fake-calendar-provider.ts';
import { UserRole, Permission } from '../src/domain/enums.ts';
import { getConfig } from '../src/lib/config.ts';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const BUCKET = process.env.BUCKET_NAME ?? 'oli-docs-local';
const SCHEDULING_QUEUE_URL =
  process.env.SCHEDULING_QUEUE_URL ??
  'http://localhost:4566/000000000000/oli-scheduling-queue';
const creds = { accessKeyId: 'local', secretAccessKey: 'local' };

const cfg = getConfig();

// --- Clients pointed at LocalStack -----------------------------------------
const ddb = createDocumentClient();
const s3 = new S3Client({
  region: REGION,
  endpoint: AWS_ENDPOINT,
  credentials: creds,
  forcePathStyle: true,
});
const sqs = new SQSClient({ region: REGION, endpoint: AWS_ENDPOINT, credentials: creds });

// --- Repos ------------------------------------------------------------------
const moduleRepo = new ModuleRepo(ddb, cfg.tableName);
const reviewerRepo = new ReviewerRepo(ddb, cfg.tableName);
const assignmentRepo = new AssignmentRepo(ddb, cfg.tableName);
const reviewRecordRepo = new ReviewRecordRepo(ddb, cfg.tableName);
const documentRepo = new DocumentRepo(ddb, cfg.tableName);
const documentStore = new DocumentStore(BUCKET, { client: s3 });

// --- Fakes for the no-local-emulator services ------------------------------
const aiProvider = new FakeAiProvider(); // name-match classifier
const calendar = new FakeCalendarProvider();

// EventBridge is not emulated; a no-op publisher keeps the flow moving.
const events = { publish: async () => {} };

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function main() {
  // --- 1. Modules ("skills") ------------------------------------------------
  log('1', 'Creating modules (skills)…');
  const now = () => new Date().toISOString();
  const modules = [
    { id: ulid(), name: 'pagos', createdAt: now() },
    { id: ulid(), name: 'control-escolar', createdAt: now() },
    { id: ulid(), name: 'ventas', createdAt: now() },
  ];
  for (const m of modules) {
    await moduleRepo.create(m);
    console.log(`   + ${m.name} (${m.id})`);
  }

  // --- 2. Reviewer + assignments (Alan is good at all three) ---------------
  log('2', 'Creating reviewer Alan and assigning his skills…');
  const alan = {
    id: ulid(),
    email: 'alan@bit.lat',
    name: 'Alan',
    role: UserRole.REVIEWER,
    active: true,
    createdAt: now(),
  };
  await reviewerRepo.create(alan);
  console.log(`   + reviewer ${alan.name} (${alan.id})`);
  for (const m of modules) {
    await assignmentRepo.put({
      reviewerId: alan.id,
      moduleId: m.id,
      permission: Permission.EDIT,
      createdAt: now(),
    });
    console.log(`   ↔ ${alan.name} assigned to ${m.name}`);
  }

  // --- 3 & 4. Upload a .md and confirm -------------------------------------
  log('3', 'Initiating a document upload…');
  const documentService = new DocumentService({
    documentRepo,
    moduleRepo,
    documentStore,
    events,
    config: cfg,
  });
  const init = await documentService.initUpload('manual-pagos.md');
  console.log(`   + document ${init.documentId} (pending_content)`);

  // Put the content straight into local S3 (the seed skips the presigned POST
  // dance — the key is deterministic from the docId).
  const key = documentStore.buildKey(init.documentId);
  const content = [
    '# Módulo de Pagos',
    '',
    'Reglas de validación de adeudos y conciliación de pagos.',
    'Este documento describe el flujo de **pagos** de la plataforma.',
  ].join('\n');
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: content, ContentType: 'text/markdown' }),
  );
  console.log(`   ↑ uploaded content to s3://${BUCKET}/${key}`);

  log('4', 'Confirming upload…');
  const confirmed = await documentService.confirmUpload(init.documentId, 'seed');
  console.log(`   → status: ${confirmed.status}`);

  // --- 5. Classification worker (S3-style event) ---------------------------
  log('5', 'Running classification worker…');
  const classificationService = new ClassificationService({
    documentRepo,
    moduleRepo,
    documentStore,
    aiProvider,
    events,
    config: cfg,
  });
  const schedulingQueue = new SqsQueueSender(SCHEDULING_QUEUE_URL, { client: sqs });

  const s3Event = {
    Records: [{ s3: { object: { key } } }],
  };
  await runClassification(s3Event, { classificationService, schedulingQueue });
  const afterClassify = await documentRepo.get(init.documentId);
  console.log(`   → status: ${afterClassify.status}, module: ${afterClassify.moduleId}`);
  const classifiedModule = modules.find((m) => m.id === afterClassify.moduleId);
  console.log(`   → classified as: ${classifiedModule?.name ?? '(none)'}`);

  // --- 6. Drain the scheduling queue → scheduling worker -------------------
  log('6', 'Draining scheduling queue and running scheduling worker…');
  const schedulingService = new SchedulingService({
    documentRepo,
    assignmentRepo,
    reviewRecordRepo,
    documentStore,
    calendar,
    events,
    config: cfg,
  });

  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: SCHEDULING_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }),
  );
  const messages = received.Messages ?? [];
  if (messages.length === 0) {
    console.log('   ! no scheduling messages found (did classification succeed?)');
  } else {
    const sqsEvent = {
      Records: messages.map((m) => ({
        messageId: m.MessageId,
        body: m.Body,
        eventSource: 'aws:sqs',
      })),
    };
    await runScheduling(sqsEvent, { schedulingService });
    // Remove processed messages so re-runs stay clean.
    for (const m of messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: SCHEDULING_QUEUE_URL, ReceiptHandle: m.ReceiptHandle }),
      );
    }
    console.log(`   → processed ${messages.length} scheduling message(s)`);
    console.log(`   → calendar blocks booked (fake): ${calendar.scheduled.length}`);
    for (const b of calendar.scheduled) {
      console.log(`      • ${b.summary} @ ${b.slot?.start ?? '(no slot)'}`);
    }
  }

  // --- 7. What the reviewer sees -------------------------------------------
  log('7', `Review records for ${alan.name}:`);
  const records = await reviewRecordRepo.listForReviewer
    ? await reviewRecordRepo.listForReviewer(alan.id)
    : [];
  if (!records.length) {
    console.log('   (none — check the steps above)');
  } else {
    for (const r of records) {
      console.log(
        `   • doc ${r.documentId} — status ${r.status}, scheduled=${r.scheduled?.done}` +
          (r.scheduled?.slot ? ` @ ${r.scheduled.slot.start}` : ''),
      );
    }
  }

  console.log('\n✅ Seed complete. The full flow ran locally — nothing was sent to AWS.');
  console.log(`   To act as this reviewer in the HTTP runner, set in local/.env.local:`);
  console.log(`     LOCAL_AUTH_USER_ID=${alan.id}`);
  console.log(`     LOCAL_AUTH_EMAIL=${alan.email}`);
  console.log(`     LOCAL_AUTH_GROUPS=revisor`);
}

main().catch((err) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
