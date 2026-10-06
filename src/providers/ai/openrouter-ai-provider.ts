import { OpenAiProvider } from './openai-ai-provider.js';

/**
 * OpenRouter provider — OpenAI-compatible wire format on a different base URL
 * (R5.5). OpenRouter recommends sending referer/title headers for routing.
 */
export class OpenRouterAiProvider extends OpenAiProvider {
  constructor(
    apiKey: string,
    model = 'openai/gpt-4o-mini',
    fetchImpl: typeof fetch = fetch,
  ) {
    super(apiKey, model, 'https://openrouter.ai/api/v1', fetchImpl);
  }

  protected override extraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://oli-docs.local',
      'X-Title': 'oli-docs',
    };
  }

  protected override providerName(): string {
    return 'OpenRouter';
  }
}
