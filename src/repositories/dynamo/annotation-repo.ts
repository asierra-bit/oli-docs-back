import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { Annotation, SectionVerdict } from '../../domain/entities.js';
import { KEY, SK_PREFIX, recordPartition } from './keys.js';
import { annotationMapper, sectionVerdictMapper } from './mappers.js';

/**
 * Persistence for Annotation and SectionVerdict entities.
 *
 * Both live under the record partition RECORD#<docId>#<reviewerId> so a
 * reviewer's work on a document is co-located and queryable in one request.
 */
export class AnnotationRepo {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  // --- Annotations ---

  async putAnnotation(a: Annotation): Promise<Annotation> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: annotationMapper.toItem(a) }),
    );
    return a;
  }

  async deleteAnnotation(
    documentId: string,
    reviewerId: string,
    annotationId: string,
  ): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: KEY.annotation(documentId, reviewerId, annotationId),
      }),
    );
  }

  async listAnnotations(documentId: string, reviewerId: string): Promise<Annotation[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': recordPartition(documentId, reviewerId),
          ':prefix': SK_PREFIX.annotation,
        },
      }),
    );
    return (res.Items ?? []).map((i) => annotationMapper.fromItem(i));
  }

  // --- Section verdicts ---

  async putSectionVerdict(v: SectionVerdict): Promise<SectionVerdict> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: sectionVerdictMapper.toItem(v) }),
    );
    return v;
  }

  async listSectionVerdicts(documentId: string, reviewerId: string): Promise<SectionVerdict[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': recordPartition(documentId, reviewerId),
          ':prefix': SK_PREFIX.verdict,
        },
      }),
    );
    return (res.Items ?? []).map((i) => sectionVerdictMapper.fromItem(i));
  }
}
