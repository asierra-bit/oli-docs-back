import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validate,
  permissionSchema,
  approvalPolicySchema,
  verdictSchema,
  markdownFilenameSchema,
  createModuleSchema,
  createReviewerSchema,
  createAssignmentSchema,
  initUploadSchema,
  createAnnotationSchema,
  forceApprovalSchema,
} from './validation.js';
import { ValidationError } from './errors.js';

describe('validate()', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('returns parsed data on valid input', () => {
    const result = validate(schema, { name: 'test' });
    expect(result).toEqual({ name: 'test' });
  });

  it('throws ValidationError with field details on invalid input', () => {
    expect(() => validate(schema, { name: '' })).toThrow(ValidationError);
    try {
      validate(schema, { name: '' });
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.details.length).toBeGreaterThan(0);
      expect(ve.details[0]!.field).toBe('name');
    }
  });

  it('strips unknown fields by default via zod strict mode test', () => {
    const result = validate(schema, { name: 'test', extra: 'ignored' });
    // Default (non-strict) zod strips extra — verify no error thrown
    expect(result.name).toBe('test');
  });
});

describe('permissionSchema', () => {
  it('accepts read and edit', () => {
    expect(permissionSchema.parse('read')).toBe('read');
    expect(permissionSchema.parse('edit')).toBe('edit');
  });

  it('rejects invalid values', () => {
    expect(() => permissionSchema.parse('admin')).toThrow();
  });
});

describe('approvalPolicySchema', () => {
  it('accepts all and any', () => {
    expect(approvalPolicySchema.parse('all')).toBe('all');
    expect(approvalPolicySchema.parse('any')).toBe('any');
  });

  it('rejects invalid values', () => {
    expect(() => approvalPolicySchema.parse('majority')).toThrow();
  });
});

describe('verdictSchema', () => {
  it('accepts correct and incorrect', () => {
    expect(verdictSchema.parse('correct')).toBe('correct');
    expect(verdictSchema.parse('incorrect')).toBe('incorrect');
  });
});

describe('markdownFilenameSchema', () => {
  it('accepts .md files', () => {
    expect(markdownFilenameSchema.parse('readme.md')).toBe('readme.md');
    expect(markdownFilenameSchema.parse('GUIDE.MD')).toBe('GUIDE.MD');
  });

  it('rejects non-.md files', () => {
    expect(() => markdownFilenameSchema.parse('file.txt')).toThrow();
    expect(() => markdownFilenameSchema.parse('document.pdf')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => markdownFilenameSchema.parse('')).toThrow();
  });
});

describe('createModuleSchema', () => {
  it('accepts valid module name', () => {
    expect(createModuleSchema.parse({ name: 'ventas' })).toEqual({ name: 'ventas' });
  });

  it('trims whitespace', () => {
    expect(createModuleSchema.parse({ name: '  ventas  ' })).toEqual({ name: 'ventas' });
  });

  it('rejects empty name', () => {
    expect(() => createModuleSchema.parse({ name: '' })).toThrow();
  });

  it('rejects name over 100 chars', () => {
    expect(() => createModuleSchema.parse({ name: 'a'.repeat(101) })).toThrow();
  });
});

describe('createReviewerSchema', () => {
  it('accepts valid data', () => {
    const result = createReviewerSchema.parse({ email: 'a@b.com', name: 'Ana' });
    expect(result).toEqual({ email: 'a@b.com', name: 'Ana' });
  });

  it('rejects invalid email', () => {
    expect(() => createReviewerSchema.parse({ email: 'not-email', name: 'X' })).toThrow();
  });
});

describe('createAssignmentSchema', () => {
  it('accepts valid assignment', () => {
    const result = createAssignmentSchema.parse({ moduleId: 'mod-1', permission: 'edit' });
    expect(result).toEqual({ moduleId: 'mod-1', permission: 'edit' });
  });

  it('rejects invalid permission', () => {
    expect(() =>
      createAssignmentSchema.parse({ moduleId: 'mod-1', permission: 'owner' }),
    ).toThrow();
  });
});

describe('initUploadSchema', () => {
  it('accepts .md filename', () => {
    const result = initUploadSchema.parse({ name: 'doc.md' });
    expect(result.name).toBe('doc.md');
  });

  it('rejects non-.md filename', () => {
    expect(() => initUploadSchema.parse({ name: 'doc.txt' })).toThrow();
  });
});

describe('createAnnotationSchema', () => {
  it('accepts valid annotation', () => {
    const result = createAnnotationSchema.parse({
      target: { type: 'section', sectionId: 'intro' },
      text: 'Needs rewrite',
    });
    expect(result.target.type).toBe('section');
    expect(result.text).toBe('Needs rewrite');
  });

  it('accepts document-level annotation', () => {
    const result = createAnnotationSchema.parse({
      target: { type: 'document' },
      text: 'Overall good',
    });
    expect(result.target.type).toBe('document');
  });

  it('rejects empty text', () => {
    expect(() =>
      createAnnotationSchema.parse({ target: { type: 'document' }, text: '' }),
    ).toThrow();
  });
});

describe('forceApprovalSchema', () => {
  it('accepts valid force-approval body', () => {
    const result = forceApprovalSchema.parse({
      excludedRecordIds: ['rec-1'],
      reason: 'Reviewer unavailable',
    });
    expect(result.excludedRecordIds).toEqual(['rec-1']);
  });

  it('rejects empty excludedRecordIds', () => {
    expect(() =>
      forceApprovalSchema.parse({ excludedRecordIds: [], reason: 'ok' }),
    ).toThrow();
  });

  it('rejects empty reason', () => {
    expect(() =>
      forceApprovalSchema.parse({ excludedRecordIds: ['r1'], reason: '' }),
    ).toThrow();
  });
});
