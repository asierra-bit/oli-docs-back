import {
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { logger } from '../../lib/logger.js';

/**
 * Stores per-reviewer Google OAuth refresh tokens (R6.8). Each reviewer's
 * token lives in its own Secrets Manager secret so it can be revoked
 * (unlinked) independently.
 */
export interface OAuthTokenStore {
  getRefreshToken(reviewerId: string): Promise<string | null>;
  saveRefreshToken(reviewerId: string, refreshToken: string): Promise<void>;
  deleteRefreshToken(reviewerId: string): Promise<void>;
  /**
   * Persist a one-time, unguessable OAuth `state` bound to the reviewer who
   * started the flow (CSRF defence). Should carry a short TTL.
   */
  saveState(state: string, reviewerId: string): Promise<void>;
  /**
   * Look up and atomically invalidate a previously-saved `state`, returning the
   * reviewerId it was bound to, or null if unknown/expired/already used.
   */
  consumeState(state: string): Promise<string | null>;
}

export class SecretsOAuthTokenStore implements OAuthTokenStore {
  private readonly client: SecretsManagerClient;

  constructor(
    private readonly prefix = 'oli-docs/google-oauth',
    options?: { region?: string; client?: SecretsManagerClient },
  ) {
    this.client = options?.client ?? new SecretsManagerClient({ region: options?.region });
  }

  private secretId(reviewerId: string): string {
    return `${this.prefix}/${reviewerId}`;
  }

  private stateSecretId(state: string): string {
    return `${this.prefix}/state/${state}`;
  }

  /** State entries are valid for this long after creation. */
  private static readonly STATE_TTL_MS = 10 * 60 * 1000; // 10 min

  async getRefreshToken(reviewerId: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.secretId(reviewerId) }),
      );
      return res.SecretString ?? null;
    } catch (err) {
      if (isResourceNotFound(err)) return null;
      throw err;
    }
  }

  async saveRefreshToken(reviewerId: string, refreshToken: string): Promise<void> {
    const SecretId = this.secretId(reviewerId);
    try {
      await this.client.send(
        new PutSecretValueCommand({ SecretId, SecretString: refreshToken }),
      );
    } catch (err) {
      if (isResourceNotFound(err)) {
        await this.client.send(
          new CreateSecretCommand({ Name: SecretId, SecretString: refreshToken }),
        );
        return;
      }
      throw err;
    }
  }

  async deleteRefreshToken(reviewerId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: this.secretId(reviewerId),
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      if (isResourceNotFound(err)) {
        logger.info('Unlink: no token to delete', { reviewerId });
        return;
      }
      throw err;
    }
  }

  async saveState(state: string, reviewerId: string): Promise<void> {
    const payload = JSON.stringify({
      reviewerId,
      expiresAt: Date.now() + SecretsOAuthTokenStore.STATE_TTL_MS,
    });
    const SecretId = this.stateSecretId(state);
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId, SecretString: payload }));
    } catch (err) {
      if (isResourceNotFound(err)) {
        await this.client.send(new CreateSecretCommand({ Name: SecretId, SecretString: payload }));
        return;
      }
      throw err;
    }
  }

  async consumeState(state: string): Promise<string | null> {
    const SecretId = this.stateSecretId(state);
    let payload: { reviewerId?: string; expiresAt?: number } | null = null;
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId }));
      payload = res.SecretString ? JSON.parse(res.SecretString) : null;
    } catch (err) {
      if (isResourceNotFound(err)) return null;
      throw err;
    }

    // Single-use: always delete, whether valid or expired.
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId, ForceDeleteWithoutRecovery: true }),
      );
    } catch (err) {
      if (!isResourceNotFound(err)) throw err;
    }

    if (!payload?.reviewerId || !payload.expiresAt || payload.expiresAt < Date.now()) {
      return null;
    }
    return payload.reviewerId;
  }
}

function isResourceNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'ResourceNotFoundException'
  );
}
