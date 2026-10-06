/**
 * Data access layer — DynamoDB single-table repos and S3 operations.
 */

export * from './dynamo/client.js';
export * from './dynamo/keys.js';
export * from './dynamo/mappers.js';
export * from './dynamo/module-repo.js';
export * from './dynamo/reviewer-repo.js';
export * from './dynamo/assignment-repo.js';
export * from './dynamo/document-repo.js';
export * from './dynamo/review-record-repo.js';
export * from './dynamo/annotation-repo.js';
export * from './dynamo/audit-repo.js';
export * from './s3/document-store.js';
export * from './sqs/queue-sender.js';
