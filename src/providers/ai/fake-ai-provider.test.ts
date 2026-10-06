import { describe, it, expect } from 'vitest';
import { FakeAiProvider } from './fake-ai-provider.js';

const modules = [
  { id: 'm1', name: 'ventas' },
  { id: 'm2', name: 'marca' },
];

describe('FakeAiProvider', () => {
  it('matches a module whose name appears in the content', async () => {
    const p = new FakeAiProvider();
    const r = await p.classifyDocument({ content: 'guia de ventas', modules });
    expect(r.moduleId).toBe('m1');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns null module when no name matches', async () => {
    const p = new FakeAiProvider();
    const r = await p.classifyDocument({ content: 'something else', modules });
    expect(r.moduleId).toBeNull();
  });

  it('honours a canned result', async () => {
    const p = new FakeAiProvider();
    p.setResult({ moduleId: 'm2', confidence: 0.42 });
    const r = await p.classifyDocument({ content: 'ventas', modules });
    expect(r.moduleId).toBe('m2');
    expect(r.confidence).toBe(0.42);
  });

  it('honours a custom impl and records calls', async () => {
    const p = new FakeAiProvider();
    p.setImpl((input) => ({ moduleId: input.modules[0]!.id, confidence: 1 }));
    await p.classifyDocument({ content: 'x', modules });
    expect(p.calls).toHaveLength(1);
  });
});
