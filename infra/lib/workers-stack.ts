import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { createNodeLambda } from './lambda-factory.js';

export interface WorkersStackProps extends cdk.StackProps {
  table: dynamodb.Table;
  bucket: s3.Bucket;
  classificationQueue: sqs.Queue;
  classificationDlq: sqs.Queue;
  schedulingQueue: sqs.Queue;
  schedulingDlq: sqs.Queue;
}

/**
 * Classification and Scheduling worker Lambdas, each consuming its SQS queue
 * with `ReportBatchItemFailures` so a single poisoned message does not force
 * the whole batch to be retried — only the failed messages are returned and
 * eventually land in the DLQ.
 */
export class WorkersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);

    const env = {
      TABLE_NAME: props.table.tableName,
      BUCKET_NAME: props.bucket.bucketName,
      SCHEDULING_QUEUE_URL: props.schedulingQueue.queueUrl,
    };

    const classificationFn = createNodeLambda(this, {
      name: 'classification-worker',
      environment: env,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    const schedulingFn = createNodeLambda(this, {
      name: 'scheduling-worker',
      environment: env,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    const workers: NodejsFunction[] = [classificationFn, schedulingFn];
    for (const fn of workers) {
      props.table.grantReadWriteData(fn);
      props.bucket.grantRead(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['events:PutEvents'], resources: ['*'] }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters'],
          resources: ['*'],
        }),
      );
    }

    // Classification worker can enqueue scheduling + invoke Bedrock.
    props.schedulingQueue.grantSendMessages(classificationFn);
    classificationFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] }),
    );

    // Event sources with partial-batch failure reporting.
    classificationFn.addEventSource(
      new SqsEventSource(props.classificationQueue, { reportBatchItemFailures: true }),
    );
    schedulingFn.addEventSource(
      new SqsEventSource(props.schedulingQueue, { reportBatchItemFailures: true }),
    );

    // Minimal visibility: alarm when either DLQ accumulates messages.
    for (const [name, dlq] of [
      ['Classification', props.classificationDlq],
      ['Scheduling', props.schedulingDlq],
    ] as const) {
      new cloudwatch.Alarm(this, `${name}DlqDepthAlarm`, {
        metric: dlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `${name} DLQ has messages`,
      });
    }
  }
}
