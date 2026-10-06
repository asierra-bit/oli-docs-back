import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { UpstreamError } from '../lib/errors.js';

/**
 * Minimal Secrets Manager reader with per-process caching.
 * API keys (OpenAI/OpenRouter) and OAuth tokens live here (R12.6).
 */
export interface SecretReader {
  getSecret(secretId: string): Promise<string>;
}

export class SecretsManagerReader implements SecretReader {
  private readonly client: SecretsManagerClient;
  private readonly cache = new Map<string, string>();

  constructor(options?: { region?: string; client?: SecretsManagerClient }) {
    this.client = options?.client ?? new SecretsManagerClient({ region: options?.region });
  }

  async getSecret(secretId: string): Promise<string> {
    const cached = this.cache.get(secretId);
    if (cached !== undefined) return cached;

    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const value = res.SecretString;
      if (value === undefined) {
        throw new UpstreamError('SecretsManager', `Secret '${secretId}' has no string value`);
      }
      this.cache.set(secretId, value);
      return value;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError(
        'SecretsManager',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
