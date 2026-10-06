/**
 * Zod-based validation helpers for Lambda handlers.
 */

import { z } from 'zod';
import { ValidationError } from './errors.js';
import type { ErrorDetail } from './errors.js';

/**
 * Validate `data` against a zod schema.
 * Throws a `ValidationError` with field-level details on failure.
 */
export function validate<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const details: ErrorDetail[] = result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    issue: issue.message,
  }));

  throw new ValidationError('Validation failed', details);
}

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

/** Permission enum schema. */
export const permissionSchema = z.enum(['read', 'edit']);

/** Approval policy enum schema. */
export const approvalPolicySchema = z.enum(['all', 'any']);

/** Verdict enum schema. */
export const verdictSchema = z.enum(['correct', 'incorrect']);

/** Non-empty trimmed string. */
export const nonEmptyString = z.string().trim().min(1, 'Must not be empty');

/**
 * Validates that a filename has the `.md` extension (case-insensitive).
 * Does NOT validate the content — that's the AI's job.
 */
export const markdownFilenameSchema = nonEmptyString.refine(
  (name) => name.toLowerCase().endsWith('.md'),
  { message: 'File must have a .md extension' },
);

/**
 * Schema for creating a module.
 */
export const createModuleSchema = z.object({
  name: nonEmptyString.max(100, 'Module name must be 100 characters or less'),
});

/**
 * Schema for updating a module. Same shape as create — kept as a named export
 * so handlers reuse one source of truth instead of redefining it inline.
 */
export const updateModuleSchema = createModuleSchema;

/**
 * Schema for creating a reviewer.
 */
export const createReviewerSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: nonEmptyString.max(200, 'Name must be 200 characters or less'),
});

/**
 * Schema for assigning a module to a reviewer.
 */
export const createAssignmentSchema = z.object({
  moduleId: nonEmptyString,
  permission: permissionSchema,
});

/**
 * Schema for updating an assignment's permission level (R3.4). The moduleId
 * comes from the path, so only the permission is in the body.
 */
export const updateAssignmentSchema = z.object({
  permission: permissionSchema,
});

/**
 * Schema for initiating a document upload. Accepts a single file name or a
 * batch of names so the handler can process several documents in one request
 * (R4.4). Each name must carry the `.md` extension (R4.2).
 */
export const initUploadSchema = z.object({
  name: markdownFilenameSchema,
});

/** Schema for a multi-file upload request (R4.4). */
export const initUploadBatchSchema = z.object({
  files: z.array(z.object({ name: markdownFilenameSchema })).min(1, 'At least one file is required'),
});

/** Schema for reassigning a document's module (manual classification, R5.6). */
export const reassignModuleSchema = z.object({
  moduleId: nonEmptyString,
});

/** Schema for setting a document's approval policy (R9.1). */
export const setApprovalPolicySchema = z.object({
  approvalPolicy: approvalPolicySchema,
});

/**
 * Schema for an annotation.
 */
export const createAnnotationSchema = z.object({
  target: z.object({
    type: z.enum(['section', 'document']),
    sectionId: z.string().optional(),
  }),
  text: nonEmptyString.max(5000, 'Annotation must be 5000 characters or less'),
});

/** Schema for a document-level verdict (R8.3). */
export const documentVerdictSchema = z.object({
  verdict: verdictSchema,
});

/** Schema for a section-level verdict (R8.2). */
export const sectionVerdictSchema = z.object({
  verdict: verdictSchema,
});

/**
 * Schema for force-approval request body.
 */
export const forceApprovalSchema = z.object({
  excludedRecordIds: z.array(z.string()).min(1, 'At least one record ID is required'),
  reason: nonEmptyString.max(500, 'Reason must be 500 characters or less'),
});
