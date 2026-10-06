import type {
  ApprovalPolicy,
  ClassificationSource,
  DocumentStatus,
  Permission,
  ReviewRecordStatus,
  UserRole,
  Verdict,
} from './enums.js';

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export interface Module {
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Reviewer (mirrors Cognito user + local metadata)
// ---------------------------------------------------------------------------

export interface Reviewer {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Assignment (reviewer ↔ module with permission level)
// ---------------------------------------------------------------------------

export interface Assignment {
  reviewerId: string;
  moduleId: string;
  permission: Permission;
  createdAt: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface DocumentClassification {
  source: ClassificationSource;
  confidence?: number; // 0..1, present when source is 'ai'
}

export interface Document {
  id: string;
  name: string;
  s3Key: string;
  status: DocumentStatus;
  moduleId?: string;
  classification?: DocumentClassification;
  approvalPolicy: ApprovalPolicy;
  approvalStatus?: 'approved' | 'rejected';
  approvalDecidedAt?: string;
  /** Records excluded during a force-approval (R9.9). */
  excludedRecords?: ExcludedRecord[];
  createdAt: string;
  updatedAt?: string;
}

export interface ExcludedRecord {
  reviewerId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// ReviewRecord (one per reviewer per document)
// ---------------------------------------------------------------------------

export interface ScheduleInfo {
  done: boolean;
  eventId?: string;
  slot?: TimeSlot;
  reason?: string; // e.g. "calendar_not_authorized"
}

export interface TimeSlot {
  start: string; // ISO 8601
  end: string;
}

export interface ReviewRecord {
  documentId: string;
  reviewerId: string;
  status: ReviewRecordStatus;
  documentVerdict?: Verdict;
  scheduled: ScheduleInfo;
  createdAt: string;
  submittedAt?: string;
}

// ---------------------------------------------------------------------------
// Annotation (within a review record)
// ---------------------------------------------------------------------------

export interface AnnotationTarget {
  type: 'section' | 'document';
  sectionId?: string; // present when type is 'section'
}

export interface Annotation {
  id: string;
  documentId: string;
  reviewerId: string;
  target: AnnotationTarget;
  text: string;
  createdAt: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// SectionVerdict (within a review record)
// ---------------------------------------------------------------------------

export interface SectionVerdict {
  documentId: string;
  reviewerId: string;
  sectionId: string;
  verdict: Verdict;
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
  timestamp: string; // ISO 8601
}
