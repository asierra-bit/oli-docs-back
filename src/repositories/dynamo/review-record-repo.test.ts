import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { ReviewRecordRepo } from './review-record-repo.js';
import { ConflictError } from '../../lib/errors.js';
import type { ReviewRecord } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new ReviewRecordRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const sample: ReviewRecord = {
  documentId: 'd1',
  reviewerId: 'u1',
  status: 'pending',
  scheduled: { done: false },
  createdAt: '2026-01-01T00:00:00Z',
};

describe('ReviewRecordRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('create succeeds when record does not exist', async () => {
    ddbMock.on(PutCommand).resolves({});
    const result = await makeRepo().create(sample);
    expect(result).toEqual(sample);
    const call = ddbMock.commandCalls(PutCommand)[0]!;
    expect(call.args[0].input.ConditionExpression).toContain('attribute_not_exists');
  });

  it('create throws ConflictError on duplicate', async () => {
    const condErr = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    ddbMock.on(PutCommand).rejects(condErr);
    await expect(makeRepo().create(sample)).rejects.toBeInstanceOf(ConflictError);
  });

  it('put upserts without uniqueness guard', async () => {
    ddbMock.on(PutCommand).resolves({});
    await makeRepo().put(sample);
    const call = ddbMock.commandCalls(PutCommand)[0]!;
    expect(call.args[0].input.ConditionExpression).toBeUndefined();
  });

  it('listForDocument queries base table by DOC partition', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          documentId: 'd1',
          reviewerId: 'u1',
          status: 'pending',
          scheduled: { done: false },
          createdAt: '2026-01-01T00:00:00Z',
          _type: 'ReviewRecord',
        },
      ],
    });
    const result = await makeRepo().listForDocument('d1');
    expect(result).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'DOC#d1',
      ':prefix': 'RECORD#',
    });
    expect(call.args[0].input.IndexName).toBeUndefined();
  });

  it('listForReviewer queries GSI2', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await makeRepo().listForReviewer('u1');
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.IndexName).toBe('GSI2');
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'USER#u1',
    });
  });

  it('get returns null when absent', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await makeRepo().get('d1', 'u1')).toBeNull();
  });

  it('hasRecordsForDocument returns true when a record exists', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ documentId: 'd1' }] });
    expect(await makeRepo().hasRecordsForDocument('d1')).toBe(true);
  });

  it('hasRecordsForDocument returns false when none exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(await makeRepo().hasRecordsForDocument('d1')).toBe(false);
  });

  it('listPending returns only pending records', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          documentId: 'd1',
          reviewerId: 'u1',
          status: 'pending',
          scheduled: { done: true },
          createdAt: 'now',
          _type: 'ReviewRecord',
        },
        {
          documentId: 'd2',
          reviewerId: 'u2',
          status: 'completed',
          scheduled: { done: true },
          createdAt: 'now',
          _type: 'ReviewRecord',
        },
      ],
    });
    const result = await makeRepo().listPending();
    expect(result).toHaveLength(1);
    expect(result[0]!.reviewerId).toBe('u1');
  });
});
