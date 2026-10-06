import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SecretsManagerReader } from './secrets.js';
import { UpstreamError } from '../lib/errors.js';

const smMock = mockClient(SecretsManagerClient);

function makeReader() {
  return new SecretsManagerReader({ client: new SecretsManagerClient({}) });
}

describe('SecretsManagerReader', () => {
  beforeEach(() => smMock.reset());

  it('returns the secret string', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: 'abc' });
    expect(await makeReader().getSecret('id')).toBe('abc');
  });

  it('caches the value (second call does not hit SDK again)', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: 'abc' });
    const reader = makeReader();
    await reader.getSecret('id');
    await reader.getSecret('id');
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('throws UpstreamError when the secret has no string value', async () => {
    smMock.on(GetSecretValueCommand).resolves({});
    await expect(makeReader().getSecret('id')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('wraps SDK errors in UpstreamError', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('denied'));
    await expect(makeReader().getSecret('id')).rejects.toBeInstanceOf(UpstreamError);
  });
});
