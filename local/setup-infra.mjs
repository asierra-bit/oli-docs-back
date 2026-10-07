#!/usr/bin/env node
/**
 * Provision the local AWS data-plane for Oli's Docs:
 *   - DynamoDB single table `AppTable` with GSI1 and GSI2 (mirrors data-stack.ts)
 *   - S3 bucket for .md content
 *   - SQS classification + scheduling queues (+ their DLQs)
 *
 * Idempotent: existing resources are left as-is. Safe to re-run.
 *
 * Endpoints come from env (DYNAMODB_ENDPOINT, AWS_ENDPOINT_URL) so this works
 * both inside the compose network and from the host (npm run local:setup).
 */

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const DDB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const TABLE_NAME = process.env.TABLE_NAME ?? 'AppTable';
const BUCKET_NAME = process.env.BUCKET_NAME ?? 'oli-docs-local';

const creds = { accessKeyId: 'local', secretAccessKey: 'local' };

const ddb = new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: creds });
const s3 = new S3Client({
  region: REGION,
  endpoint: AWS_ENDPOINT,
  credentials: creds,
  forcePathStyle: true,
});
const sqs = new SQSClient({ region: REGION, endpoint: AWS_ENDPOINT, credentials: creds });

async function tableExists(name) {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function createTable() {
  if (await tableExists(TABLE_NAME)) {
    console.log(`  = table ${TABLE_NAME} already exists`);
    return;
  }
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  console.log(`  + created table ${TABLE_NAME} (GSI1, GSI2)`);
}

async function createBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    console.log(`  = bucket ${BUCKET_NAME} already exists`);
    return;
  } catch {
    // fall through to create
  }
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
  console.log(`  + created bucket ${BUCKET_NAME}`);
}

async function createQueue(name) {
  try {
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    console.log(`  = queue ${name} already exists`);
    return existing.QueueUrl;
  } catch {
    const res = await sqs.send(new CreateQueueCommand({ QueueName: name }));
    console.log(`  + created queue ${name}`);
    return res.QueueUrl;
  }
}

async function main() {
  console.log('Provisioning local AWS data-plane for Oli\'s Docs…');
  console.log(`  DynamoDB: ${DDB_ENDPOINT}`);
  console.log(`  AWS (S3/SQS): ${AWS_ENDPOINT}`);
  console.log('');

  await createTable();
  await createBucket();
  // DLQs first, then the main queues (parity with data-stack.ts).
  await createQueue('oli-classification-dlq');
  await createQueue('oli-classification-queue');
  await createQueue('oli-scheduling-dlq');
  await createQueue('oli-scheduling-queue');

  console.log('\nDone. Local infrastructure is ready.');
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  process.exit(1);
});
