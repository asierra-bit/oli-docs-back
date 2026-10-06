import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * EventBridge bus + scheduled rules for system events.
 * Placeholder — Review Timeout Checker rule added in task 15.5.
 */
export class EventsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Uses the default EventBridge bus — no custom bus needed for cost reasons.
    // TODO: Task 15.5 — Scheduled rule for Review Timeout Checker
  }
}
