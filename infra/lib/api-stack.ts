import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  table: dynamodb.Table;
  bucket: s3.Bucket;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

/**
 * API Gateway HTTP API + Lambda handlers.
 * Placeholder — routes and Lambdas will be added in later tasks.
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // TODO: Task 5+ — HTTP API, JWT authorizer, Lambda handlers, routes
    new cdk.CfnOutput(this, 'TableName', { value: props.table.tableName });
    new cdk.CfnOutput(this, 'BucketName', { value: props.bucket.bucketName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: props.userPool.userPoolId });
  }
}
