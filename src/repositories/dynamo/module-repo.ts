import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Module } from '../../domain/entities.js';
import { ConflictError } from '../../lib/errors.js';
import { KEY } from './keys.js';
import { moduleMapper } from './mappers.js';
import { scanAllByType } from './scan.js';

/**
 * Persistence for Module entities.
 *
 * Uniqueness of module names is enforced by a sentinel item
 * `MODULE_NAME#<lowercased name>` written conditionally in the same request
 * flow. This keeps name uniqueness atomic without a GSI.
 */
export class ModuleRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private nameSentinelKey(name: string) {
    return { PK: `MODULE_NAME#${name.toLowerCase()}`, SK: 'UNIQUE' };
  }

  /**
   * Create a module, enforcing name uniqueness (R1.5).
   *
   * The name sentinel and the module item are written in a single
   * TransactWriteItems so a partial failure can never orphan a sentinel
   * (which would leave a name permanently unclaimable).
   */
  async create(m: Module): Promise<Module> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...this.nameSentinelKey(m.name), moduleId: m.id },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: moduleMapper.toItem(m),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isTransactionConflict(err)) {
        throw new ConflictError(`Module name '${m.name}' already exists`);
      }
      throw err;
    }
    return m;
  }

  async get(moduleId: string): Promise<Module | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: KEY.module(moduleId) }),
    );
    return res.Item ? moduleMapper.fromItem(res.Item) : null;
  }

  async list(): Promise<Module[]> {
    const items = await scanAllByType(this.client, {
      tableName: this.tableName,
      type: 'Module',
    });
    return items.map((i) => moduleMapper.fromItem(i));
  }

  /**
   * Update the module name (R1.4).
   *
   * Reserving the new sentinel, releasing the old sentinel and updating the
   * module item happen in a single TransactWriteItems, so the rename is
   * all-or-nothing (no window where the module keeps the old name while the
   * old sentinel is already released).
   */
  async updateName(moduleId: string, newName: string, current: Module): Promise<Module> {
    const updatedAt = new Date().toISOString();
    const sameName = current.name.toLowerCase() === newName.toLowerCase();

    const updateModule = {
      Update: {
        TableName: this.tableName,
        Key: KEY.module(moduleId),
        UpdateExpression: 'SET #n = :name, updatedAt = :u',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':name': newName, ':u': updatedAt },
        ConditionExpression: 'attribute_exists(PK)',
      },
    };

    // Changing only casing/whitespace of the same name: no sentinel churn.
    const transactItems = sameName
      ? [updateModule]
      : [
          {
            Put: {
              TableName: this.tableName,
              Item: { ...this.nameSentinelKey(newName), moduleId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: this.nameSentinelKey(current.name),
            },
          },
          updateModule,
        ];

    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (isTransactionConflict(err)) {
        throw new ConflictError(`Module name '${newName}' already exists`);
      }
      throw err;
    }
    return { ...current, name: newName, updatedAt };
  }

  /**
   * Delete a module and release its name sentinel atomically (R1.6).
   *
   * The module item delete is guarded with `attribute_exists(PK)` so a
   * concurrent delete fails cleanly instead of silently succeeding twice.
   */
  async delete(moduleId: string, name: string): Promise<void> {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: KEY.module(moduleId),
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: this.nameSentinelKey(name),
            },
          },
        ],
      }),
    );
  }
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'ConditionalCheckFailedException'
  );
}

/**
 * A TransactWriteItems fails with TransactionCanceledException; the per-item
 * ConditionalCheckFailed reasons are nested in CancellationReasons. Treat both
 * the transaction cancellation and a plain conditional failure as a conflict.
 */
export function isTransactionConflict(err: unknown): boolean {
  if (isConditionalCheckFailed(err)) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'TransactionCanceledException'
  );
}
