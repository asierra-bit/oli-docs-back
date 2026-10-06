import type { AiProvider, ClassificationInput, ClassificationResult } from './types.js';

/**
 * Deterministic AiProvider for tests and local/offline runs (R5.5).
 *
 * Default behaviour: pick the first module whose name (case-insensitive)
 * appears in the content; otherwise return a null-module result. Behaviour can
 * be overridden with a canned result or a custom function.
 */
export class FakeAiProvider implements AiProvider {
  private canned?: ClassificationResult;
  private impl?: (input: ClassificationInput) => ClassificationResult;
  public calls: ClassificationInput[] = [];

  /** Force every call to return this result. */
  setResult(result: ClassificationResult): void {
    this.canned = result;
    this.impl = undefined;
  }

  /** Provide a custom classification function. */
  setImpl(fn: (input: ClassificationInput) => ClassificationResult): void {
    this.impl = fn;
    this.canned = undefined;
  }

  async classifyDocument(input: ClassificationInput): Promise<ClassificationResult> {
    this.calls.push(input);

    if (this.canned) return this.canned;
    if (this.impl) return this.impl(input);

    const lower = input.content.toLowerCase();
    const match = input.modules.find((m) => lower.includes(m.name.toLowerCase()));
    if (match) {
      return { moduleId: match.id, confidence: 0.95, rationale: 'name match' };
    }
    return { moduleId: null, confidence: 0.2, rationale: 'no name match' };
  }
}
