import { UpstreamError } from '../../lib/errors.js';
import type { AiProvider, ClassificationInput, ClassificationResult } from './types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseClassificationResponse } from './prompt.js';

/**
 * OpenAI-compatible Chat Completions provider. OpenRouter uses the same wire
 * format, so OpenRouterAiProvider subclasses this with a different base URL
 * (R5.5).
 */
export class OpenAiProvider implements AiProvider {
  constructor(
    protected readonly apiKey: string,
    protected readonly model: string = 'gpt-4o-mini',
    protected readonly baseUrl: string = 'https://api.openai.com/v1',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async classifyDocument(input: ClassificationInput): Promise<ClassificationResult> {
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      text = json.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      throw new UpstreamError(this.providerName(), err instanceof Error ? err.message : String(err));
    }

    const validIds = new Set(input.modules.map((m) => m.id));
    return parseClassificationResponse(text, validIds);
  }

  /** Hook for subclasses to add provider-specific headers. */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  protected providerName(): string {
    return 'OpenAI';
  }
}
