import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ModuleRepo } from './module-repo.js';
import { ConflictError } from '../../lib/errors.js';
import type { Module } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'TestTable';

function makeRepo() {
  return new ModuleRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const sample: Module = { id: 'm1', name: 'ventas', createdAt: '2026-01-01T00:00:00Z' };

/** Build a TransactionCanceledException as the SDK would surface it. */
function transactionCanceled() {
  return Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
}

describe('ModuleRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('create writes name sentinel + module item in a single transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await makeRepo().create(sample);
    expect(result).toEqual(sample);
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    // Two atomic puts: name sentinel + module item.
    expect(calls[0]!.args[0].input.TransactItems).toHaveLength(2);
  });

  it('create throws ConflictError (409) when the transaction is cancelled', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled());
    await expect(makeRepo().create(sample)).rejects.toBeInstanceOf(ConflictError);
  });

  it('get returns null when not found', async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await makeRepo().get('missing');
    expect(result).toBeNull();
  });

  it('get maps item to Module', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: 'm1', name: 'ventas', createdAt: '2026-01-01T00:00:00Z', _type: 'Module' },
    });
    const result = await makeRepo().get('m1');
    expect(result).toEqual(sample);
  });

  it('list filters by _type Module', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { id: 'm1', name: 'ventas', createdAt: '2026-01-01T00:00:00Z', _type: 'Module' },
        { id: 'm2', name: 'marca', createdAt: '2026-01-02T00:00:00Z', _type: 'Module' },
      ],
    });
    const result = await makeRepo().list();
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('ventas');
  });

  it('updateName swaps sentinels and updates the item in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await makeRepo().updateName('m1', 'nuevas-ventas', sample);
    expect(result.name).toBe('nuevas-ventas');
    expect(result.updatedAt).toBeDefined();
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    // Reserve new sentinel + release old sentinel + update module item.
    expect(calls[0]!.args[0].input.TransactItems).toHaveLength(3);
  });

  it('updateName throws ConflictError if the new name is taken', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled());
    await expect(
      makeRepo().updateName('m1', 'taken-name', sample),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('updateName skips sentinel swap when name unchanged (case-insensitive)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await makeRepo().updateName('m1', 'VENTAS', sample);
    expect(result.name).toBe('VENTAS');
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    // Only the module update — no sentinel reservation/release.
    expect(calls[0]!.args[0].input.TransactItems).toHaveLength(1);
  });

  it('delete removes module and name sentinel atomically', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await makeRepo().delete('m1', 'ventas');
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.TransactItems).toHaveLength(2);
  });
});
