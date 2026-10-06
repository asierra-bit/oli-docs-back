import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Reviewer } from '../../domain/entities.js';
import { ConflictError } from '../../lib/errors.js';
import { KEY } from './keys.js';
import { reviewerMapper } from './mappers.js';
import { isTransactionConflict } from './module-repo.js';
import { scanAllByType } from './scan.js';

/**
 * Persistence for Reviewer entities.
 *
 * Email uniqueness is enforced via a sentinel item `EMAIL#<lowercased email>`.
 * Cognito is the system of record for auth; this stores local metadata and
 * module assignments live alongside under the same USER partition.
 */
export class ReviewerRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private emailSentinelKey(email: string) {
    return { PK: `EMAIL#${email.toLowerCase()}`, SK: 'UNIQUE' };
  }

  /**
   * Create a reviewer, enforcing email uniqueness (R2.2).
   *
   * The email sentinel and the reviewer item are written in a single
   * TransactWriteItems so a partial failure can never orphan the email
   * sentinel (which would make that email permanently unregisterable).
   */
  async create(r: Reviewer): Promise<Reviewer> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...this.emailSentinelKey(r.email), userId: r.id },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: reviewerMapper.toItem(r),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isTransactionConflict(err)) {
        throw new ConflictError(`Email '${r.email}' is already registered`);
      }
      throw err;
    }
    return r;
  }

  async get(userId: string): Promise<Reviewer | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: KEY.user(userId) }),
    );
    return res.Item ? reviewerMapper.fromItem(res.Item) : null;
  }

  async list(): Promise<Reviewer[]> {
    const items = await scanAllByType(this.client, {
      tableName: this.tableName,
      type: 'Reviewer',
    });
    return items.map((i) => reviewerMapper.fromItem(i));
  }

  /** Deactivate a reviewer — preserves history (R2.4). */
  async setActive(userId: string, active: boolean): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: KEY.user(userId),
        UpdateExpression: 'SET active = :a',
        ExpressionAttributeValues: { ':a': active },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  }
}
