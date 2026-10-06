/**
 * Entity ↔ DynamoDB item mappers.
 *
 * Each mapper converts a domain entity into a flat item (with PK/SK and GSI
 * attributes) and back. The `_type` attribute tags each item for debugging
 * and defensive deserialisation.
 */

import type {
  Annotation,
  Assignment,
  AuditLog,
  Document,
  Module,
  Reviewer,
  ReviewRecord,
  SectionVerdict,
} from '../../domain/entities.js';
import { UserRole } from '../../domain/enums.js';
import { GSI1, GSI2, KEY, recordPartition } from './keys.js';

export type Item = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const moduleMapper = {
  toItem(m: Module): Item {
    return {
      ...KEY.module(m.id),
      _type: 'Module',
      id: m.id,
      name: m.name,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  },
  fromItem(item: Item): Module {
    return {
      id: item.id as string,
      name: item.name as string,
      createdAt: item.createdAt as string,
      updatedAt: item.updatedAt as string | undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export const reviewerMapper = {
  toItem(r: Reviewer): Item {
    return {
      ...KEY.user(r.id),
      _type: 'Reviewer',
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      active: r.active,
      createdAt: r.createdAt,
    };
  },
  fromItem(item: Item): Reviewer {
    return {
      id: item.id as string,
      email: item.email as string,
      name: item.name as string,
      // Read the stored role; fall back to REVIEWER for legacy items that
      // predate persisting the role attribute.
      role: (item.role as Reviewer['role']) ?? UserRole.REVIEWER,
      active: item.active as boolean,
      createdAt: item.createdAt as string,
    };
  },
};

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export const assignmentMapper = {
  toItem(a: Assignment): Item {
    return {
      ...KEY.assignment(a.reviewerId, a.moduleId),
      ...GSI1.assignmentByModule(a.moduleId, a.reviewerId),
      _type: 'Assignment',
      reviewerId: a.reviewerId,
      moduleId: a.moduleId,
      permission: a.permission,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  },
  fromItem(item: Item): Assignment {
    return {
      reviewerId: item.reviewerId as string,
      moduleId: item.moduleId as string,
      permission: item.permission as Assignment['permission'],
      createdAt: item.createdAt as string,
      updatedAt: item.updatedAt as string | undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const documentMapper = {
  toItem(d: Document): Item {
    const base: Item = {
      ...KEY.document(d.id),
      _type: 'Document',
      id: d.id,
      name: d.name,
      s3Key: d.s3Key,
      status: d.status,
      moduleId: d.moduleId,
      classification: d.classification,
      approvalPolicy: d.approvalPolicy,
      approvalStatus: d.approvalStatus,
      approvalDecidedAt: d.approvalDecidedAt,
      excludedRecords: d.excludedRecords,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
    // Only index by module once classified into one.
    if (d.moduleId) {
      Object.assign(base, GSI1.documentByModule(d.moduleId, d.id));
    }
    return base;
  },
  fromItem(item: Item): Document {
    return {
      id: item.id as string,
      name: item.name as string,
      s3Key: item.s3Key as string,
      status: item.status as Document['status'],
      moduleId: item.moduleId as string | undefined,
      classification: item.classification as Document['classification'],
      approvalPolicy: item.approvalPolicy as Document['approvalPolicy'],
      approvalStatus: item.approvalStatus as Document['approvalStatus'],
      approvalDecidedAt: item.approvalDecidedAt as string | undefined,
      excludedRecords: item.excludedRecords as Document['excludedRecords'],
      createdAt: item.createdAt as string,
      updatedAt: item.updatedAt as string | undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// ReviewRecord
// ---------------------------------------------------------------------------

export const reviewRecordMapper = {
  toItem(r: ReviewRecord): Item {
    return {
      ...KEY.reviewRecord(r.documentId, r.reviewerId),
      ...GSI2.recordByReviewer(r.reviewerId, r.documentId),
      _type: 'ReviewRecord',
      documentId: r.documentId,
      reviewerId: r.reviewerId,
      status: r.status,
      documentVerdict: r.documentVerdict,
      scheduled: r.scheduled,
      createdAt: r.createdAt,
      submittedAt: r.submittedAt,
    };
  },
  fromItem(item: Item): ReviewRecord {
    return {
      documentId: item.documentId as string,
      reviewerId: item.reviewerId as string,
      status: item.status as ReviewRecord['status'],
      documentVerdict: item.documentVerdict as ReviewRecord['documentVerdict'],
      scheduled: item.scheduled as ReviewRecord['scheduled'],
      createdAt: item.createdAt as string,
      submittedAt: item.submittedAt as string | undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

export const annotationMapper = {
  toItem(a: Annotation): Item {
    return {
      ...KEY.annotation(a.documentId, a.reviewerId, a.id),
      _type: 'Annotation',
      id: a.id,
      documentId: a.documentId,
      reviewerId: a.reviewerId,
      target: a.target,
      text: a.text,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  },
  fromItem(item: Item): Annotation {
    return {
      id: item.id as string,
      documentId: item.documentId as string,
      reviewerId: item.reviewerId as string,
      target: item.target as Annotation['target'],
      text: item.text as string,
      createdAt: item.createdAt as string,
      updatedAt: item.updatedAt as string | undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// SectionVerdict
// ---------------------------------------------------------------------------

export const sectionVerdictMapper = {
  toItem(v: SectionVerdict): Item {
    return {
      ...KEY.sectionVerdict(v.documentId, v.reviewerId, v.sectionId),
      _type: 'SectionVerdict',
      documentId: v.documentId,
      reviewerId: v.reviewerId,
      sectionId: v.sectionId,
      verdict: v.verdict,
    };
  },
  fromItem(item: Item): SectionVerdict {
    return {
      documentId: item.documentId as string,
      reviewerId: item.reviewerId as string,
      sectionId: item.sectionId as string,
      verdict: item.verdict as SectionVerdict['verdict'],
    };
  },
};

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

export const auditLogMapper = {
  toItem(a: AuditLog): Item {
    const date = a.timestamp.slice(0, 10); // yyyy-mm-dd
    return {
      ...KEY.auditLog(date, a.timestamp, a.id),
      _type: 'AuditLog',
      id: a.id,
      actor: a.actor,
      action: a.action,
      target: a.target,
      details: a.details,
      timestamp: a.timestamp,
    };
  },
  fromItem(item: Item): AuditLog {
    return {
      id: item.id as string,
      actor: item.actor as string,
      action: item.action as string,
      target: item.target as string,
      details: item.details as Record<string, unknown> | undefined,
      timestamp: item.timestamp as string,
    };
  },
};

/** Exposed for tests needing the record partition helper. */
export { recordPartition };
