import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { UpstreamError } from '../../lib/errors.js';
import type { AiProvider, ClassificationInput, ClassificationResult } from './types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseClassificationResponse } from './prompt.js';

const DEFAULT_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

/**
 * Default AI provider using Amazon Bedrock (R5.4). Uses the Anthropic Messages
 * API shape, which is the on-demand default for Claude models on Bedrock.
 */
export class BedrockAiProvider implements AiProvider {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string = DEFAULT_MODEL_ID,
    options?: { region?: string; client?: BedrockRuntimeClient },
  ) {
    this.client = options?.client ?? new BedrockRuntimeClient({ region: options?.region });
  }

  async classifyDocument(input: ClassificationInput): Promise<ClassificationResult> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    };

    let text: string;
    try {
      const res = await this.client.send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }),
      );
      const decoded = JSON.parse(new TextDecoder().decode(res.body)) as {
        content?: { text?: string }[];
      };
      text = decoded.content?.[0]?.text ?? '';
    } catch (err) {
      throw new UpstreamError('Bedrock', err instanceof Error ? err.message : String(err));
    }

    const validIds = new Set(input.modules.map((m) => m.id));
    return parseClassificationResponse(text, validIds);
  }
}
