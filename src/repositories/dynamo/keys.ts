/**
 * Single-table key construction helpers.
 *
 * All entities live in one DynamoDB table keyed by generic PK/SK.
 * GSI1 (byModule) and GSI2 (byReviewer) provide secondary access patterns.
 *
 * See design.md "Estrategia DynamoDB (single-table)".
 */

export const KEY = {
  module: (moduleId: string) => ({ PK: `MODULE#${moduleId}`, SK: 'META' }),

  user: (userId: string) => ({ PK: `USER#${userId}`, SK: 'META' }),

  assignment: (userId: string, moduleId: string) => ({
    PK: `USER#${userId}`,
    SK: `ASSIGN#${moduleId}`,
  }),

  document: (docId: string) => ({ PK: `DOC#${docId}`, SK: 'META' }),

  reviewRecord: (docId: string, reviewerId: string) => ({
    PK: `DOC#${docId}`,
    SK: `RECORD#${reviewerId}`,
  }),

  annotation: (docId: string, reviewerId: string, annotationId: string) => ({
    PK: `RECORD#${docId}#${reviewerId}`,
    SK: `ANNO#${annotationId}`,
  }),

  sectionVerdict: (docId: string, reviewerId: string, sectionId: string) => ({
    PK: `RECORD#${docId}#${reviewerId}`,
    SK: `VERDICT#${sectionId}`,
  }),

  auditLog: (date: string, ts: string, id: string) => ({
    PK: `AUDIT#${date}`,
    SK: `TS#${ts}#${id}`,
  }),
} as const;

/** Prefix of the SK used to query all records of a document. */
export const SK_PREFIX = {
  record: 'RECORD#',
  assignment: 'ASSIGN#',
  annotation: 'ANNO#',
  verdict: 'VERDICT#',
} as const;

/** Prefix of the PK used to query annotations/verdicts of a record. */
export function recordPartition(docId: string, reviewerId: string): string {
  return `RECORD#${docId}#${reviewerId}`;
}

// ---------------------------------------------------------------------------
// GSI key helpers
// ---------------------------------------------------------------------------

export const GSI1 = {
  INDEX_NAME: 'GSI1',
  /** Document belongs to a module. */
  documentByModule: (moduleId: string, docId: string) => ({
    GSI1PK: `MODULE#${moduleId}`,
    GSI1SK: `DOC#${docId}`,
  }),
  /** Assignment of a module (reverse lookup: reviewers of a module). */
  assignmentByModule: (moduleId: string, userId: string) => ({
    GSI1PK: `MODULE#${moduleId}`,
    GSI1SK: `ASSIGN#${userId}`,
  }),
  modulePartition: (moduleId: string) => `MODULE#${moduleId}`,
} as const;

export const GSI2 = {
  INDEX_NAME: 'GSI2',
  /** Review record owned by a reviewer. */
  recordByReviewer: (reviewerId: string, docId: string) => ({
    GSI2PK: `USER#${reviewerId}`,
    GSI2SK: `RECORD#${docId}`,
  }),
  reviewerPartition: (reviewerId: string) => `USER#${reviewerId}`,
} as const;
