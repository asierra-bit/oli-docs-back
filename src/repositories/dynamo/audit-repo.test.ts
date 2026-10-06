import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AuditRepo } from './audit-repo.js';
import type { AuditLog } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new AuditRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const entry: AuditLog = {
  id: 'log1',
  actor: 'admin-1',
  action: 'create_reviewer',
  target: 'USER#u1',
  details: { email: 'ana@example.com' },
  timestamp: '2026-03-15T12:30:00.000Z',
};

describe('AuditRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('append writes an item partitioned by day', async () => {
    ddbMock.on(PutCommand).resolves({});
    await makeRepo().append(entry);
    const call = ddbMock.commandCalls(PutCommand)[0]!;
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe('AUDIT#2026-03-15');
    expect(item.action).toBe('create_reviewer');
  });

  it('listForDay queries the day partition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...entry, _type: 'AuditLog' }] });
    const result = await makeRepo().listForDay('2026-03-15');
    expect(result).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'AUDIT#2026-03-15',
    });
  });
});
