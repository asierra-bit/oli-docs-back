#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { WorkersStack } from '../lib/workers-stack.js';
import { EventsStack } from '../lib/events-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const dataStack = new DataStack(app, 'OliDocs-Data', { env });
const authStack = new AuthStack(app, 'OliDocs-Auth', { env });

const apiStack = new ApiStack(app, 'OliDocs-Api', {
  env,
  table: dataStack.table,
  bucket: dataStack.bucket,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
});

new WorkersStack(app, 'OliDocs-Workers', {
  env,
  table: dataStack.table,
  bucket: dataStack.bucket,
  classificationQueue: dataStack.classificationQueue,
  schedulingQueue: dataStack.schedulingQueue,
});

new EventsStack(app, 'OliDocs-Events', { env });

// Explicit dependencies
apiStack.addDependency(dataStack);
apiStack.addDependency(authStack);
