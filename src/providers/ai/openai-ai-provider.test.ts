import { describe, it, expect, vi } from 'vitest';
import { OpenAiProvider } from './openai-ai-provider.js';
import { OpenRouterAiProvider } from './openrouter-ai-provider.js';
import { UpstreamError } from '../../lib/errors.js';

const modules = [{ id: 'm1', name: 'ventas' }];

function fakeFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body,
  }) as unknown as typeof fetch;
}

describe('OpenAiProvider', () => {
  it('parses the chat completion content into a result', async () => {
    const f = fakeFetch({
      ok: true,
      body: { choices: [{ message: { content: '{"moduleId":"m1","confidence":0.88}' } }] },
    });
    const p = new OpenAiProvider('key', 'gpt-4o-mini', 'https://api.openai.com/v1', f);
    const r = await p.classifyDocument({ content: 'ventas', modules });
    expect(r.moduleId).toBe('m1');
    expect(r.confidence).toBe(0.88);
  });

  it('sends the bearer token', async () => {
    const f = fakeFetch({
      ok: true,
      body: { choices: [{ message: { content: '{"moduleId":null,"confidence":0}' } }] },
    });
    const p = new OpenAiProvider('secret-key', 'gpt-4o-mini', 'https://api.openai.com/v1', f);
    await p.classifyDocument({ content: 'x', modules });
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].headers.authorization).toBe('Bearer secret-key');
  });

  it('throws UpstreamError on non-ok response', async () => {
    const f = fakeFetch({ ok: false, status: 429 });
    const p = new OpenAiProvider('key', 'gpt-4o-mini', 'https://api.openai.com/v1', f);
    await expect(p.classifyDocument({ content: 'x', modules })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe('OpenRouterAiProvider', () => {
  it('targets the OpenRouter base URL and sends routing headers', async () => {
    const f = fakeFetch({
      ok: true,
      body: { choices: [{ message: { content: '{"moduleId":"m1","confidence":0.7}' } }] },
    });
    const p = new OpenRouterAiProvider('key', 'openai/gpt-4o-mini', f);
    await p.classifyDocument({ content: 'ventas', modules });
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain('openrouter.ai');
    expect(call[1].headers['X-Title']).toBe('oli-docs');
  });
});
