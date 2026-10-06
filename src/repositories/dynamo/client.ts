import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Builds a DynamoDBDocumentClient.
 *
 * Supports a local endpoint (DynamoDB Local) via DYNAMODB_ENDPOINT for
 * integration testing. In Lambda the default resolver chain is used.
 */
export function createDocumentClient(options?: {
  region?: string;
  endpoint?: string;
}): DynamoDBDocumentClient {
  const endpoint = options?.endpoint ?? process.env.DYNAMODB_ENDPOINT;
  const region = options?.region ?? process.env.AWS_REGION ?? 'us-east-1';

  const base = new DynamoDBClient({
    region,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: 'local',
            secretAccessKey: 'local',
          },
        }
      : {}),
  });

  return DynamoDBDocumentClient.from(base, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
  });
}
