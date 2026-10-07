import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { createNodeLambda } from './lambda-factory.js';

export interface EventsStackProps extends cdk.StackProps {
  table: dynamodb.Table;
}

/**
 * System events run on the default EventBridge bus (no custom bus, to keep
 * cost/footprint minimal — R13). This stack owns the daily scheduled rule that
 * drives the Review Timeout Checker (R9.9). Integration consumers attach their
 * own rules/targets to the default bus; none are predefined here.
 */
export class EventsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);

    const timeoutCheckerFn = createNodeLambda(this, {
      name: 'review-timeout-checker',
      environment: { TABLE_NAME: props.table.tableName },
      timeout: cdk.Duration.minutes(2),
    });

    props.table.grantReadData(timeoutCheckerFn);
    timeoutCheckerFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['events:PutEvents'], resources: ['*'] }),
    );

    // Daily scan for pending reviews past their deadline.
    new events.Rule(this, 'ReviewTimeoutSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(timeoutCheckerFn)],
      description: 'Daily Review Timeout Checker (R9.9)',
    });
  }
}
