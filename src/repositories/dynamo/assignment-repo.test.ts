import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { AssignmentRepo } from './assignment-repo.js';
import type { Assignment } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new AssignmentRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const sample: Assignment = {
  reviewerId: 'u1',
  moduleId: 'm1',
  permission: 'edit',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('AssignmentRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('put persists assignment', async () => {
    ddbMock.on(PutCommand).resolves({});
    const result = await makeRepo().put(sample);
    expect(result).toEqual(sample);
  });

  it('listForReviewer queries base table by USER partition', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          reviewerId: 'u1',
          moduleId: 'm1',
          permission: 'edit',
          createdAt: '2026-01-01T00:00:00Z',
          _type: 'Assignment',
        },
      ],
    });
    const result = await makeRepo().listForReviewer('u1');
    expect(result).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'USER#u1',
      ':prefix': 'ASSIGN#',
    });
    expect(call.args[0].input.IndexName).toBeUndefined();
  });

  it('listForModule queries GSI1', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          reviewerId: 'u1',
          moduleId: 'm1',
          permission: 'read',
          createdAt: '2026-01-01T00:00:00Z',
          _type: 'Assignment',
        },
      ],
    });
    const result = await makeRepo().listForModule('m1');
    expect(result[0]!.permission).toBe('read');
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'MODULE#m1',
    });
  });

  it('hasAssignmentsForModule returns true when items exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ reviewerId: 'u1' }] });
    expect(await makeRepo().hasAssignmentsForModule('m1')).toBe(true);
  });

  it('hasAssignmentsForModule returns false when empty', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(await makeRepo().hasAssignmentsForModule('m1')).toBe(false);
  });

  it('updatePermission issues conditional update', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await makeRepo().updatePermission('u1', 'm1', 'read');
    const call = ddbMock.commandCalls(UpdateCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({ ':p': 'read' });
    expect(call.args[0].input.ConditionExpression).toContain('attribute_exists');
  });

  it('remove deletes the assignment', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await makeRepo().remove('u1', 'm1');
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});
