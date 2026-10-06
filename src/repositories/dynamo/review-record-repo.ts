import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { ReviewRecord } from '../../domain/entities.js';
import { ReviewRecordStatus } from '../../domain/enums.js';
import { ConflictError } from '../../lib/errors.js';
import { KEY, GSI2, SK_PREFIX } from './keys.js';
import { reviewRecordMapper } from './mappers.js';
import { isConditionalCheckFailed } from './module-repo.js';
import { scanAllByType } from './scan.js';

/**
 * Persistence for ReviewRecord entities (one per reviewer per document).
 */
export class ReviewRecordRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Create a record idempotently — a second create for the same pair is a no-op conflict. */
  async create(r: ReviewRecord): Promise<ReviewRecord> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: reviewRecordMapper.toItem(r),
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new ConflictError(
          `Review record already exists for document '${r.documentId}' and reviewer '${r.reviewerId}'`,
        );
      }
      throw err;
    }
    return r;
  }

  /** Upsert without the uniqueness guard (used by workers idempotently). */
  async put(r: ReviewRecord): Promise<ReviewRecord> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: reviewRecordMapper.toItem(r) }),
    );
    return r;
  }

  async get(documentId: string, reviewerId: string): Promise<ReviewRecord | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: KEY.reviewRecord(documentId, reviewerId) }),
    );
    return res.Item ? reviewRecordMapper.fromItem(res.Item) : null;
  }

  /** True if a document already has at least one review record (dedup guard). */
  async hasRecordsForDocument(documentId: string): Promise<boolean> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `DOC#${documentId}`,
          ':prefix': SK_PREFIX.record,
        },
        Limit: 1,
      }),
    );
    return (res.Items?.length ?? 0) > 0;
  }

  /** All review records of a document (R9.3). */
  async listForDocument(documentId: string): Promise<ReviewRecord[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `DOC#${documentId}`,
          ':prefix': SK_PREFIX.record,
        },
      }),
    );
    return (res.Items ?? []).map((i) => reviewRecordMapper.fromItem(i));
  }

  /**
   * All review records still in `pending` across the table (R9.9).
   *
   * Used by the Review Timeout Checker. COST NOTE: this is a filtered Scan;
   * acceptable at event scale. If data grows, add a GSI partitioning pending
   * records by status instead.
   */
  async listPending(): Promise<ReviewRecord[]> {
    const items = await scanAllByType(this.client, {
      tableName: this.tableName,
      type: 'ReviewRecord',
    });
    return items
      .map((i) => reviewRecordMapper.fromItem(i))
      .filter((r) => r.status === ReviewRecordStatus.PENDING);
  }

  /** All review records owned by a reviewer, via GSI2 (R7.3). */
  async listForReviewer(reviewerId: string): Promise<ReviewRecord[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2.INDEX_NAME,
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': GSI2.reviewerPartition(reviewerId),
          ':prefix': SK_PREFIX.record,
        },
      }),
    );
    return (res.Items ?? []).map((i) => reviewRecordMapper.fromItem(i));
  }
}
