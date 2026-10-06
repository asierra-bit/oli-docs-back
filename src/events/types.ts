/**
 * System event types published to EventBridge (R13).
 */

export const SystemEventType = {
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_CLASSIFIED: 'document.classified',
  DOCUMENT_NEEDS_MANUAL_CLASSIFICATION: 'document.needs_manual_classification',
  REVIEW_SCHEDULED: 'review.scheduled',
  REVIEW_RECORD_COMPLETED: 'review_record.completed',
  DOCUMENT_APPROVED: 'document.approved',
  DOCUMENT_REJECTED: 'document.rejected',
  REVIEW_DEADLINE_EXPIRED: 'review.deadline_expired',
} as const;

export type SystemEventType = (typeof SystemEventType)[keyof typeof SystemEventType];

/** Payload published to EventBridge. */
export interface SystemEvent {
  type: SystemEventType;
  resourceId: string;
  timestamp: string; // ISO 8601
  actor?: string; // userId if applicable
  detail?: Record<string, unknown>;
}
