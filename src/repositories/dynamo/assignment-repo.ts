import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Assignment } from '../../domain/entities.js';
import type { Permission } from '../../domain/enums.js';
import { KEY, GSI1, SK_PREFIX } from './keys.js';
import { assignmentMapper } from './mappers.js';

/**
 * Persistence for Assignment entities (reviewer ↔ module with permission).
 *
 * Stored under USER#<reviewerId> / ASSIGN#<moduleId> and mirrored in GSI1
 * (byModule) to resolve "reviewers of a module" (R6.1).
 */
export class AssignmentRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(a: Assignment): Promise<Assignment> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: assignmentMapper.toItem(a) }),
    );
    return a;
  }

  async get(reviewerId: string, moduleId: string): Promise<Assignment | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: KEY.assignment(reviewerId, moduleId) }),
    );
    return res.Item ? assignmentMapper.fromItem(res.Item) : null;
  }

  async updatePermission(
    reviewerId: string,
    moduleId: string,
    permission: Permission,
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: KEY.assignment(reviewerId, moduleId),
        UpdateExpression: 'SET permission = :p, updatedAt = :u',
        ExpressionAttributeValues: { ':p': permission, ':u': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  }

  async remove(reviewerId: string, moduleId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({ TableName: this.tableName, Key: KEY.assignment(reviewerId, moduleId) }),
    );
  }

  /** All assignments for a reviewer (R3.7). */
  async listForReviewer(reviewerId: string): Promise<Assignment[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${reviewerId}`,
          ':prefix': SK_PREFIX.assignment,
        },
      }),
    );
    return (res.Items ?? []).map((i) => assignmentMapper.fromItem(i));
  }

  /** All reviewers assigned to a module, via GSI1 (R6.1). */
  async listForModule(moduleId: string): Promise<Assignment[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.INDEX_NAME,
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': GSI1.modulePartition(moduleId),
          ':prefix': SK_PREFIX.assignment,
        },
      }),
    );
    return (res.Items ?? []).map((i) => assignmentMapper.fromItem(i));
  }

  /** Count module dependencies on a module (for safe deletion, R1.6). */
  async hasAssignmentsForModule(moduleId: string): Promise<boolean> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.INDEX_NAME,
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': GSI1.modulePartition(moduleId),
          ':prefix': SK_PREFIX.assignment,
        },
        Limit: 1,
      }),
    );
    return (res.Items?.length ?? 0) > 0;
  }
}
