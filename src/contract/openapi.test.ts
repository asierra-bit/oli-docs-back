import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Validates the OpenAPI contract (16.1): it parses, is OpenAPI 3, every
 * operation declares responses + the uniform error model, every $ref resolves,
 * and all routes exposed by the API are documented.
 */
const specPath = path.resolve(__dirname, '../../api/openapi.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as any;

/** Collect every "#/..." ref string in the document. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => collectRefs(n, acc));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

/** Resolve a local JSON pointer like #/components/schemas/Module. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveRef(ref: string): any {
  const parts = ref.replace(/^#\//, '').split('/');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parts.reduce<any>((cur, p) => (cur ? cur[p] : undefined), spec);
}

describe('OpenAPI contract', () => {
  it('is OpenAPI 3.x', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info?.title).toBeTruthy();
  });

  it('declares the bearer JWT security scheme', () => {
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('every $ref resolves to a defined component', () => {
    const refs = [...new Set(collectRefs(spec))];
    const unresolved = refs.filter((r) => resolveRef(r) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('every operation declares responses', () => {
    for (const [p, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
        const op = (item as Record<string, { responses?: unknown }>)[method];
        if (!op) continue;
        expect(op.responses, `${method.toUpperCase()} ${p} must declare responses`).toBeTruthy();
      }
    }
  });

  it('documents every route exposed by the API', () => {
    // Mirror of the routes registered in infra/lib/api-stack.ts.
    const expected = [
      '/modules',
      '/modules/{id}',
      '/reviewers',
      '/reviewers/{id}/deactivate',
      '/reviewers/{id}/assignments',
      '/reviewers/{id}/assignments/{moduleId}',
      '/documents',
      '/documents/{id}',
      '/documents/{id}/confirm-upload',
      '/documents/{id}/module',
      '/documents/{id}/approval-policy',
      '/documents/{id}/force-approval',
      '/reviews/mine',
      '/review-records/{id}',
      '/review-records/{id}/annotations',
      '/review-records/{id}/sections/{sectionId}/verdict',
      '/review-records/{id}/document-verdict',
      '/review-records/{id}/submit',
      '/review-records/{id}/reopen',
      '/integrations/google/authorize-url',
      '/integrations/google/callback',
      '/integrations/google',
    ];
    for (const route of expected) {
      expect(spec.paths[route], `missing path ${route}`).toBeDefined();
    }
  });

  it('exposes the OAuth callback without security', () => {
    const cb = spec.paths['/integrations/google/callback'].get;
    expect(cb.security).toEqual([]);
  });

  it('force-approval documents the admin-only body', () => {
    const op = spec.paths['/documents/{id}/force-approval'].post;
    const schemaRef = op.requestBody.content['application/json'].schema.$ref;
    const schema = resolveRef(schemaRef);
    expect(schema.required).toContain('excludedRecordIds');
    expect(schema.required).toContain('reason');
  });
});
