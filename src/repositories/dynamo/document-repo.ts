import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Document } from '../../domain/entities.js';
import { KEY, GSI1 } from './keys.js';
import { documentMapper } from './mappers.js';
import { scanAllByType } from './scan.js';

/**
 * Persistence for Document entities.
 */
export class DocumentRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(d: Document): Promise<Document> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: documentMapper.toItem(d) }),
    );
    return d;
  }

  async get(docId: string): Promise<Document | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: KEY.document(docId) }),
    );
    return res.Item ? documentMapper.fromItem(res.Item) : null;
  }

  async list(): Promise<Document[]> {
    const items = await scanAllByType(this.client, {
      tableName: this.tableName,
      type: 'Document',
    });
    return items.map((i) => documentMapper.fromItem(i));
  }

  /** Documents classified into a module, via GSI1 (R6.1). */
  async listByModule(moduleId: string): Promise<Document[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.INDEX_NAME,
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': GSI1.modulePartition(moduleId),
          ':prefix': 'DOC#',
        },
      }),
    );
    return (res.Items ?? []).map((i) => documentMapper.fromItem(i));
  }

  /** True if any document is classified into the module (for safe deletion, R1.6). */
  async hasDocumentsForModule(moduleId: string): Promise<boolean> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.INDEX_NAME,
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': GSI1.modulePartition(moduleId),
          ':prefix': 'DOC#',
        },
        Limit: 1,
      }),
    );
    return (res.Items?.length ?? 0) > 0;
  }

  /**
   * Full overwrite of a document (used when fields change together, e.g.
   * reclassification which must also update GSI1 attributes).
   */
  async update(d: Document): Promise<Document> {
    return this.put({ ...d, updatedAt: new Date().toISOString() });
  }

  /** Update only the status field. */
  async updateStatus(docId: string, status: Document['status']): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: KEY.document(docId),
        UpdateExpression: 'SET #s = :s, updatedAt = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status, ':u': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  }
}
