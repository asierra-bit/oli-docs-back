import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAiProvider } from './bedrock-ai-provider.js';
import { UpstreamError } from '../../lib/errors.js';

const bedrockMock = mockClient(BedrockRuntimeClient);
const modules = [{ id: 'm1', name: 'ventas' }];

function makeProvider() {
  return new BedrockAiProvider('model-x', { client: new BedrockRuntimeClient({}) });
}

function encode(obj: unknown) {
  // The provider only calls `new TextDecoder().decode(body)`, so a Uint8Array
  // is sufficient at runtime; cast to satisfy the SDK's blob adapter type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TextEncoder().encode(JSON.stringify(obj)) as any;
}

describe('BedrockAiProvider', () => {
  beforeEach(() => bedrockMock.reset());

  it('parses the Anthropic messages response', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encode({ content: [{ text: '{"moduleId":"m1","confidence":0.91}' }] }),
    });
    const r = await makeProvider().classifyDocument({ content: 'ventas', modules });
    expect(r.moduleId).toBe('m1');
    expect(r.confidence).toBe(0.91);
  });

  it('wraps SDK failures in UpstreamError', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('throttled'));
    await expect(
      makeProvider().classifyDocument({ content: 'x', modules }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
