import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { createNodeLambda } from './lambda-factory.js';

export interface ApiStackProps extends cdk.StackProps {
  table: dynamodb.Table;
  bucket: s3.Bucket;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  schedulingQueueUrl: string;
  /** Base URL of the frontend (for the Calendar OAuth callback redirect). */
  frontUrl?: string;
}

/**
 * HTTP API (cheaper than REST) + native JWT authorizer against Cognito, with
 * one Lambda per resource group. The Google OAuth callback is deliberately
 * exposed WITHOUT the authorizer, since the browser redirect from Google
 * carries no bearer token (the reviewer is identified via the signed `state`).
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const env = {
      TABLE_NAME: props.table.tableName,
      BUCKET_NAME: props.bucket.bucketName,
      USER_POOL_ID: props.userPool.userPoolId,
      SCHEDULING_QUEUE_URL: props.schedulingQueueUrl,
      // Where the Google Calendar OAuth callback redirects the reviewer back to.
      FRONT_URL: props.frontUrl ?? 'http://localhost:4321',
    };

    const modulesFn = createNodeLambda(this, { name: 'modules', environment: env });
    const reviewersFn = createNodeLambda(this, { name: 'reviewers', environment: env });
    const documentsFn = createNodeLambda(this, { name: 'documents', environment: env });
    const reviewRecordsFn = createNodeLambda(this, { name: 'review-records', environment: env });
    const integrationsFn = createNodeLambda(this, { name: 'integrations', environment: env });

    const apiLambdas: NodejsFunction[] = [
      modulesFn,
      reviewersFn,
      documentsFn,
      reviewRecordsFn,
      integrationsFn,
    ];

    // Grant data-plane permissions to every API Lambda.
    for (const fn of apiLambdas) {
      props.table.grantReadWriteData(fn);
      props.bucket.grantReadWrite(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: ['*'],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters'],
          resources: ['*'],
        }),
      );
    }

    // Reviewer management needs Cognito admin actions.
    reviewersFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminDisableUser',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // Integrations manage per-reviewer OAuth token secrets.
    integrationsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DeleteSecret',
        ],
        resources: ['*'],
      }),
    );

    // --- HTTP API + JWT authorizer ---
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'oli-docs-api',
    });

    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer('CognitoAuthorizer', issuer, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    const addRoute = (
      pathPart: string,
      methods: apigwv2.HttpMethod[],
      fn: NodejsFunction,
      opts: { authorized: boolean } = { authorized: true },
    ) => {
      httpApi.addRoutes({
        path: pathPart,
        methods,
        integration: new HttpLambdaIntegration(`Int${pathPart}${methods.join()}`, fn),
        ...(opts.authorized ? { authorizer } : {}),
      });
    };

    const { GET, POST, PATCH, DELETE, PUT } = apigwv2.HttpMethod;

    // Modules (admin)
    addRoute('/v1/modules', [POST, GET], modulesFn);
    addRoute('/v1/modules/{id}', [GET, PATCH, DELETE], modulesFn);

    // Reviewers + assignments (admin)
    addRoute('/v1/reviewers', [POST, GET], reviewersFn);
    addRoute('/v1/reviewers/{id}/deactivate', [POST], reviewersFn);
    addRoute('/v1/reviewers/{id}/assignments', [GET, POST], reviewersFn);
    addRoute('/v1/reviewers/{id}/assignments/{moduleId}', [PATCH, DELETE], reviewersFn);

    // Documents (admin)
    addRoute('/v1/documents', [POST, GET], documentsFn);
    addRoute('/v1/documents/{id}', [GET], documentsFn);
    addRoute('/v1/documents/{id}/content', [GET], documentsFn);
    addRoute('/v1/documents/{id}/confirm-upload', [POST], documentsFn);
    addRoute('/v1/documents/{id}/module', [PATCH], documentsFn);
    addRoute('/v1/documents/{id}/approval-policy', [PATCH], documentsFn);
    addRoute('/v1/documents/{id}/force-approval', [POST], documentsFn);

    // Review records (reviewer/admin)
    addRoute('/v1/reviews/mine', [GET], reviewRecordsFn);
    addRoute('/v1/review-records/{id}', [GET], reviewRecordsFn);
    addRoute('/v1/review-records/{id}/annotations', [POST], reviewRecordsFn);
    addRoute('/v1/review-records/{id}/sections/{sectionId}/verdict', [PUT], reviewRecordsFn);
    addRoute('/v1/review-records/{id}/document-verdict', [PUT], reviewRecordsFn);
    addRoute('/v1/review-records/{id}/submit', [POST], reviewRecordsFn);
    addRoute('/v1/review-records/{id}/reopen', [POST], reviewRecordsFn);

    // Google integration — authorize-url requires auth, but the OAuth callback
    // must be reachable WITHOUT the JWT authorizer (browser redirect from
    // Google has no bearer token). The reviewer is bound via the `state` value.
    addRoute('/v1/integrations/google/authorize-url', [GET], integrationsFn);
    addRoute('/v1/integrations/google/callback', [GET], integrationsFn, { authorized: false });
    addRoute('/v1/integrations/google', [DELETE], integrationsFn);

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
