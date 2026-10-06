import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAdminClient } from './cognito-admin.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

function makeClient() {
  return new CognitoAdminClient('pool-1', {
    client: new CognitoIdentityProviderClient({}),
  });
}

describe('CognitoAdminClient', () => {
  beforeEach(() => cognitoMock.reset());

  it('createReviewer returns the sub and adds to revisor group', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Username: 'ana', Attributes: [{ Name: 'sub', Value: 'sub-123' }] },
    });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

    const userId = await makeClient().createReviewer('ana@example.com', 'Ana');
    expect(userId).toBe('sub-123');

    const groupCall = cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0]!;
    expect(groupCall.args[0].input.GroupName).toBe('revisor');
  });

  it('falls back to Username when sub is not echoed', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({ User: { Username: 'ana-user' } });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    const userId = await makeClient().createReviewer('ana@example.com', 'Ana');
    expect(userId).toBe('ana-user');
  });

  it('throws when Cognito returns no identifier', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({ User: {} });
    await expect(makeClient().createReviewer('a@b.com', 'A')).rejects.toThrow();
  });

  it('rolls back the created user when adding to the group fails', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Username: 'ana@example.com', Attributes: [{ Name: 'sub', Value: 'sub-123' }] },
    });
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error('group boom'));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    await expect(makeClient().createReviewer('ana@example.com', 'Ana')).rejects.toThrow('group boom');
    const del = cognitoMock.commandCalls(AdminDeleteUserCommand)[0]!;
    expect(del.args[0].input.Username).toBe('ana@example.com');
  });

  it('disableUser calls AdminDisableUser with the given username', async () => {
    cognitoMock.on(AdminDisableUserCommand).resolves({});
    await makeClient().disableUser('ana@example.com');
    const call = cognitoMock.commandCalls(AdminDisableUserCommand)[0]!;
    expect(call.args[0].input.Username).toBe('ana@example.com');
  });

  it('deleteUser is idempotent when the user does not exist', async () => {
    cognitoMock
      .on(AdminDeleteUserCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'UserNotFoundException' }));
    await expect(makeClient().deleteUser('ghost@example.com')).resolves.toBeUndefined();
  });
});
