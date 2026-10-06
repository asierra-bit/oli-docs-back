import type { AppConfig } from '../../lib/config.js';
import { UpstreamError } from '../../lib/errors.js';
import type { SecretReader } from '../secrets.js';
import { BedrockAiProvider } from './bedrock-ai-provider.js';
import { OpenAiProvider } from './openai-ai-provider.js';
import { OpenRouterAiProvider } from './openrouter-ai-provider.js';
import type { AiProvider } from './types.js';

/**
 * Build the configured AiProvider (R5.4, R5.5). Bedrock is the default and
 * needs no secret; OpenAI/OpenRouter read their API key from Secrets Manager.
 */
export async function createAiProvider(
  config: Pick<AppConfig, 'aiProvider' | 'aiModel' | 'aiApiKeySecretId' | 'region'>,
  secrets: SecretReader,
): Promise<AiProvider> {
  switch (config.aiProvider) {
    case 'openai': {
      const apiKey = await requireApiKey(config.aiApiKeySecretId, secrets, 'OpenAI');
      return new OpenAiProvider(apiKey, config.aiModel);
    }
    case 'openrouter': {
      const apiKey = await requireApiKey(config.aiApiKeySecretId, secrets, 'OpenRouter');
      return new OpenRouterAiProvider(apiKey, config.aiModel);
    }
    case 'bedrock':
    default:
      return new BedrockAiProvider(config.aiModel, { region: config.region });
  }
}

async function requireApiKey(
  secretId: string | undefined,
  secrets: SecretReader,
  provider: string,
): Promise<string> {
  if (!secretId) {
    throw new UpstreamError(provider, 'AI_API_KEY_SECRET_ID is not configured');
  }
  return secrets.getSecret(secretId);
}
