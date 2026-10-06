import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AuditLog } from '../../domain/entities.js';
import { auditLogMapper } from './mappers.js';

/**
 * Persistence for AuditLog entries (R10.6).
 *
 * Partitioned by day (AUDIT#yyyy-mm-dd) so a day's audit trail is queryable
 * without a scan.
 */
export class AuditRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async append(entry: AuditLog): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: auditLogMapper.toItem(entry) }),
    );
  }

  /** List audit entries for a given day (yyyy-mm-dd). */
  async listForDay(date: string): Promise<AuditLog[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `AUDIT#${date}` },
      }),
    );
    return (res.Items ?? []).map((i) => auditLogMapper.fromItem(i));
  }
}
