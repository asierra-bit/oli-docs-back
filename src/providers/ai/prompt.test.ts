import { describe, it, expect } from 'vitest';
import { buildUserPrompt, parseClassificationResponse } from './prompt.js';

const modules = [
  { id: 'm1', name: 'ventas' },
  { id: 'm2', name: 'marca', description: 'brand guidelines' },
];

describe('buildUserPrompt', () => {
  it('includes module ids/names and the content', () => {
    const p = buildUserPrompt({ content: 'hello world', modules });
    expect(p).toContain('m1');
    expect(p).toContain('ventas');
    expect(p).toContain('brand guidelines');
    expect(p).toContain('hello world');
  });

  it('truncates very long content', () => {
    const long = 'x'.repeat(20000);
    const p = buildUserPrompt({ content: long, modules });
    expect(p).toContain('x'.repeat(12000));
    expect(p).not.toContain('x'.repeat(12001));
  });
});

describe('parseClassificationResponse', () => {
  const valid = new Set(['m1', 'm2']);

  it('parses a clean JSON object', () => {
    const r = parseClassificationResponse('{"moduleId":"m1","confidence":0.9}', valid);
    expect(r.moduleId).toBe('m1');
    expect(r.confidence).toBe(0.9);
  });

  it('extracts JSON embedded in prose', () => {
    const r = parseClassificationResponse(
      'Sure! Here is the result:\n{"moduleId":"m2","confidence":0.8,"rationale":"brand"}\nThanks',
      valid,
    );
    expect(r.moduleId).toBe('m2');
    expect(r.rationale).toBe('brand');
  });

  it('rejects an invented module id (not in the valid set)', () => {
    const r = parseClassificationResponse('{"moduleId":"ghost","confidence":0.99}', valid);
    expect(r.moduleId).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('clamps confidence into [0,1]', () => {
    const over = parseClassificationResponse('{"moduleId":"m1","confidence":5}', valid);
    expect(over.confidence).toBe(1);
    const under = parseClassificationResponse('{"moduleId":"m1","confidence":-2}', valid);
    expect(under.confidence).toBe(0);
  });

  it('returns null-module zero-confidence for unparseable output', () => {
    const r = parseClassificationResponse('not json at all', valid);
    expect(r.moduleId).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.rationale).toBe('unparseable_response');
  });
});
