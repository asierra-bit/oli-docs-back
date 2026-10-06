import {
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { UserRole } from '../../domain/enums.js';
import { logger } from '../../lib/logger.js';

/**
 * Thin wrapper around the Cognito Admin API used by ReviewerService.
 *
 * Kept as an interface + concrete implementation so services can be tested
 * with a fake, and so the SDK surface stays confined to this module.
 */
export interface CognitoAdmin {
  /**
   * Create a user in the pool with the given email/name and add them to the
   * `revisor` group. Returns the Cognito `sub` (used as the reviewer id).
   */
  createReviewer(email: string, name: string): Promise<string>;
  /**
   * Delete a user from the pool (used to compensate a failed local write).
   * Idempotent: a missing user is treated as success.
   */
  deleteUser(username: string): Promise<void>;
  /**
   * Disable a user so they can no longer authenticate (R2.4).
   * `username` must be the Cognito username (this pool uses the email as the
   * username — NOT the `sub`).
   */
  disableUser(username: string): Promise<void>;
}

export class CognitoAdminClient implements CognitoAdmin {
  private readonly client: CognitoIdentityProviderClient;

  constructor(
    private readonly userPoolId: string,
    options?: { region?: string; client?: CognitoIdentityProviderClient },
  ) {
    this.client = options?.client ?? new CognitoIdentityProviderClient({ region: options?.region });
  }

  async createReviewer(email: string, name: string): Promise<string> {
    const res = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: name },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );

    const sub = res.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    // Fall back to the username Cognito assigned if sub isn't echoed back.
    const userId = sub ?? res.User?.Username;
    if (!userId) {
      throw new Error('Cognito did not return a user identifier');
    }

    try {
      await this.client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          GroupName: UserRole.REVIEWER,
        }),
      );
    } catch (err) {
      // The user exists but isn't in the revisor group — they'd authenticate
      // yet fail every role guard. Roll the half-created user back so the
      // caller can retry cleanly.
      logger.error('Failed to add user to group; rolling back created user', {
        email,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.deleteUser(email);
      throw err;
    }

    return userId;
  }

  async deleteUser(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({
          UserPoolId: this.userPoolId,
          Username: username,
        }),
      );
    } catch (err) {
      if (isUserNotFound(err)) return; // idempotent
      throw err;
    }
  }

  async disableUser(username: string): Promise<void> {
    await this.client.send(
      new AdminDisableUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
  }
}

/** True if a Cognito error indicates the user does not exist. */
function isUserNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'UserNotFoundException'
  );
}
