import { describe, it, expect } from 'vitest';
import {
  moduleMapper,
  reviewerMapper,
  assignmentMapper,
  documentMapper,
  reviewRecordMapper,
  annotationMapper,
  sectionVerdictMapper,
  auditLogMapper,
} from './mappers.js';
import type {
  Module,
  Reviewer,
  Assignment,
  Document,
  ReviewRecord,
  Annotation,
  SectionVerdict,
  AuditLog,
} from '../../domain/entities.js';

describe('entity ↔ item round-trips', () => {
  it('Module', () => {
    const m: Module = { id: 'm1', name: 'ventas', createdAt: '2026-01-01T00:00:00Z' };
    const item = moduleMapper.toItem(m);
    expect(item.PK).toBe('MODULE#m1');
    expect(item._type).toBe('Module');
    expect(moduleMapper.fromItem(item)).toEqual(m);
  });

  it('Reviewer', () => {
    const r: Reviewer = {
      id: 'u1',
      email: 'a@b.com',
      name: 'Ana',
      role: 'revisor',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = reviewerMapper.toItem(r);
    expect(item.PK).toBe('USER#u1');
    expect(reviewerMapper.fromItem(item)).toEqual(r);
  });

  it('Assignment includes GSI1 attributes', () => {
    const a: Assignment = {
      reviewerId: 'u1',
      moduleId: 'm1',
      permission: 'edit',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = assignmentMapper.toItem(a);
    expect(item.PK).toBe('USER#u1');
    expect(item.SK).toBe('ASSIGN#m1');
    expect(item.GSI1PK).toBe('MODULE#m1');
    expect(item.GSI1SK).toBe('ASSIGN#u1');
    expect(assignmentMapper.fromItem(item)).toEqual(a);
  });

  it('Document with module sets GSI1 attributes', () => {
    const d: Document = {
      id: 'd1',
      name: 'guide.md',
      s3Key: 'documents/d1.md',
      status: 'classified',
      moduleId: 'm1',
      classification: { source: 'ai', confidence: 0.9 },
      approvalPolicy: 'all',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = documentMapper.toItem(d);
    expect(item.GSI1PK).toBe('MODULE#m1');
    expect(item.GSI1SK).toBe('DOC#d1');
    expect(documentMapper.fromItem(item)).toEqual(d);
  });

  it('Document without module omits GSI1 attributes', () => {
    const d: Document = {
      id: 'd1',
      name: 'guide.md',
      s3Key: 'documents/d1.md',
      status: 'pending_content',
      approvalPolicy: 'all',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = documentMapper.toItem(d);
    expect(item.GSI1PK).toBeUndefined();
    expect(documentMapper.fromItem(item)).toEqual(d);
  });

  it('ReviewRecord includes GSI2 attributes', () => {
    const r: ReviewRecord = {
      documentId: 'd1',
      reviewerId: 'u1',
      status: 'pending',
      scheduled: { done: false },
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = reviewRecordMapper.toItem(r);
    expect(item.GSI2PK).toBe('USER#u1');
    expect(item.GSI2SK).toBe('RECORD#d1');
    expect(reviewRecordMapper.fromItem(item)).toEqual(r);
  });

  it('Annotation', () => {
    const a: Annotation = {
      id: 'a1',
      documentId: 'd1',
      reviewerId: 'u1',
      target: { type: 'section', sectionId: 'intro' },
      text: 'fix this',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const item = annotationMapper.toItem(a);
    expect(item.PK).toBe('RECORD#d1#u1');
    expect(annotationMapper.fromItem(item)).toEqual(a);
  });

  it('SectionVerdict', () => {
    const v: SectionVerdict = {
      documentId: 'd1',
      reviewerId: 'u1',
      sectionId: 's1',
      verdict: 'correct',
    };
    const item = sectionVerdictMapper.toItem(v);
    expect(item.PK).toBe('RECORD#d1#u1');
    expect(item.SK).toBe('VERDICT#s1');
    expect(sectionVerdictMapper.fromItem(item)).toEqual(v);
  });

  it('AuditLog partitions by day', () => {
    const a: AuditLog = {
      id: 'log1',
      actor: 'admin',
      action: 'create_module',
      target: 'MODULE#m1',
      timestamp: '2026-03-15T12:30:00.000Z',
    };
    const item = auditLogMapper.toItem(a);
    expect(item.PK).toBe('AUDIT#2026-03-15');
    expect(item.SK).toBe('TS#2026-03-15T12:30:00.000Z#log1');
    expect(auditLogMapper.fromItem(item)).toEqual(a);
  });
});
