import { describe, it, expect, vi } from 'vitest';
import { createAiProvider } from './factory.js';
import { BedrockAiProvider } from './bedrock-ai-provider.js';
import { OpenAiProvider } from './openai-ai-provider.js';
import { OpenRouterAiProvider } from './openrouter-ai-provider.js';
import { UpstreamError } from '../../lib/errors.js';

const baseConfig = {
  aiProvider: 'bedrock',
  aiModel: undefined,
  aiApiKeySecretId: undefined,
  region: 'us-east-1',
};

const secrets = { getSecret: vi.fn().mockResolvedValue('secret-key') };

describe('createAiProvider', () => {
  it('returns BedrockAiProvider by default', async () => {
    const p = await createAiProvider({ ...baseConfig }, secrets);
    expect(p).toBeInstanceOf(BedrockAiProvider);
  });

  it('returns OpenAiProvider when configured, reading the API key', async () => {
    const p = await createAiProvider(
      { ...baseConfig, aiProvider: 'openai', aiApiKeySecretId: 'secret/openai' },
      secrets,
    );
    expect(p).toBeInstanceOf(OpenAiProvider);
    expect(secrets.getSecret).toHaveBeenCalledWith('secret/openai');
  });

  it('returns OpenRouterAiProvider when configured', async () => {
    const p = await createAiProvider(
      { ...baseConfig, aiProvider: 'openrouter', aiApiKeySecretId: 'secret/or' },
      secrets,
    );
    expect(p).toBeInstanceOf(OpenRouterAiProvider);
  });

  it('throws UpstreamError when API key secret id is missing', async () => {
    await expect(
      createAiProvider({ ...baseConfig, aiProvider: 'openai' }, secrets),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
