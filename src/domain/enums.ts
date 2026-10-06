/** Status of a document through its lifecycle. */
export const DocumentStatus = {
  PENDING_CONTENT: 'pending_content',
  CLASSIFYING: 'classifying',
  CLASSIFIED: 'classified',
  NEEDS_MANUAL_CLASSIFICATION: 'needs_manual_classification',
  CLASSIFICATION_FAILED: 'classification_failed',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/** Status of a review record. */
export const ReviewRecordStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
} as const;

export type ReviewRecordStatus = (typeof ReviewRecordStatus)[keyof typeof ReviewRecordStatus];

/** Module permission level for a reviewer. */
export const Permission = {
  READ: 'read',
  EDIT: 'edit',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/** Verdict a reviewer gives to a section or document. */
export const Verdict = {
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
} as const;

export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/** Policy that determines how a document is approved. */
export const ApprovalPolicy = {
  ALL: 'all',
  ANY: 'any',
} as const;

export type ApprovalPolicy = (typeof ApprovalPolicy)[keyof typeof ApprovalPolicy];

/** Source of a document's module classification. */
export const ClassificationSource = {
  AI: 'ai',
  MANUAL: 'manual',
} as const;

export type ClassificationSource =
  (typeof ClassificationSource)[keyof typeof ClassificationSource];

/** Role of a user in the system. */
export const UserRole = {
  ADMIN: 'admin',
  REVIEWER: 'revisor',
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];
