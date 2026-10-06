import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ReviewerRepo } from './reviewer-repo.js';
import { ConflictError } from '../../lib/errors.js';
import type { Reviewer } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new ReviewerRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const sample: Reviewer = {
  id: 'u1',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'revisor',
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('ReviewerRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('create writes email sentinel + reviewer item in a single transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await makeRepo().create(sample);
    expect(result).toEqual(sample);
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.TransactItems).toHaveLength(2);
  });

  it('create throws ConflictError (409) on duplicate email', async () => {
    const cancelled = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);
    await expect(makeRepo().create(sample)).rejects.toBeInstanceOf(ConflictError);
  });

  it('get maps item', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        id: 'u1',
        email: 'ana@example.com',
        name: 'Ana',
        role: 'revisor',
        active: true,
        createdAt: '2026-01-01T00:00:00Z',
        _type: 'Reviewer',
      },
    });
    expect(await makeRepo().get('u1')).toEqual(sample);
  });

  it('list filters by _type Reviewer', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          id: 'u1',
          email: 'ana@example.com',
          name: 'Ana',
          role: 'revisor',
          active: true,
          createdAt: '2026-01-01T00:00:00Z',
          _type: 'Reviewer',
        },
      ],
    });
    const result = await makeRepo().list();
    expect(result).toHaveLength(1);
  });

  it('setActive(false) deactivates (preserves history)', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await makeRepo().setActive('u1', false);
    const call = ddbMock.commandCalls(UpdateCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({ ':a': false });
  });
});
