import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DocumentRepo } from './document-repo.js';
import type { Document } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new DocumentRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const sample: Document = {
  id: 'd1',
  name: 'guide.md',
  s3Key: 'documents/d1.md',
  status: 'classified',
  moduleId: 'm1',
  approvalPolicy: 'all',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('DocumentRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('put persists document', async () => {
    ddbMock.on(PutCommand).resolves({});
    expect(await makeRepo().put(sample)).toEqual(sample);
  });

  it('get maps item', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...sample, _type: 'Document' },
    });
    expect(await makeRepo().get('d1')).toEqual(sample);
  });

  it('listByModule queries GSI1 with DOC prefix', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...sample, _type: 'Document' }] });
    const result = await makeRepo().listByModule('m1');
    expect(result).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'MODULE#m1',
      ':prefix': 'DOC#',
    });
  });

  it('hasDocumentsForModule returns true when docs exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'd1' }] });
    expect(await makeRepo().hasDocumentsForModule('m1')).toBe(true);
  });

  it('hasDocumentsForModule returns false when none', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(await makeRepo().hasDocumentsForModule('m1')).toBe(false);
  });

  it('updateStatus issues conditional update', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await makeRepo().updateStatus('d1', 'approved');
    const call = ddbMock.commandCalls(UpdateCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({ ':s': 'approved' });
    expect(call.args[0].input.ConditionExpression).toContain('attribute_exists');
  });

  it('update sets updatedAt and overwrites', async () => {
    ddbMock.on(PutCommand).resolves({});
    const result = await makeRepo().update(sample);
    expect(result.updatedAt).toBeDefined();
  });
});
