/**
 * AI provider abstraction for document → module classification (R5).
 *
 * The classification logic depends only on this interface, so the concrete
 * provider (Bedrock, OpenAI, OpenRouter) is swappable by configuration
 * (R5.4, R5.5) without touching ClassificationService.
 */

export interface ModuleOption {
  id: string;
  name: string;
  description?: string;
}

export interface ClassificationInput {
  content: string;
  modules: ModuleOption[];
}

export interface ClassificationResult {
  /** The chosen module id, or null when the model is not confident enough. */
  moduleId: string | null;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Optional short rationale, useful for debugging/audit. */
  rationale?: string;
}

export interface AiProvider {
  classifyDocument(input: ClassificationInput): Promise<ClassificationResult>;
}
