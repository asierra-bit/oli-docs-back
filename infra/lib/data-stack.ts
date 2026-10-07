import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly bucket: s3.Bucket;
  public readonly classificationQueue: sqs.Queue;
  public readonly classificationDlq: sqs.Queue;
  public readonly schedulingQueue: sqs.Queue;
  public readonly schedulingDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- DynamoDB single-table ---
    this.table = new dynamodb.Table(this, 'AppTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- S3 bucket for .md documents ---
    this.bucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // --- SQS queues ---
    this.classificationDlq = new sqs.Queue(this, 'ClassificationDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.classificationQueue = new sqs.Queue(this, 'ClassificationQueue', {
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: this.classificationDlq,
        maxReceiveCount: 3,
      },
    });

    this.schedulingDlq = new sqs.Queue(this, 'SchedulingDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.schedulingQueue = new sqs.Queue(this, 'SchedulingQueue', {
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: this.schedulingDlq,
        maxReceiveCount: 3,
      },
    });

    // Fire classification when a document's .md content lands in S3 (R4.6):
    // only `documents/` keys with the `.md` suffix trigger the pipeline.
    this.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.classificationQueue),
      { prefix: 'documents/', suffix: '.md' },
    );
  }
}
