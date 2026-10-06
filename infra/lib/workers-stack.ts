import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface WorkersStackProps extends cdk.StackProps {
  table: dynamodb.Table;
  bucket: s3.Bucket;
  classificationQueue: sqs.Queue;
  schedulingQueue: sqs.Queue;
}

/**
 * Classification and Scheduling worker Lambdas.
 * Placeholder — implementations added in tasks 9 and 11.
 */
export class WorkersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);

    // TODO: Task 9 — Classification Worker Lambda + S3 event source
    // TODO: Task 11 — Scheduling Worker Lambda + SQS event source
  }
}
