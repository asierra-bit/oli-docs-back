import { describe, it, expect } from 'vitest';
import { KEY, GSI1, GSI2, recordPartition, SK_PREFIX } from './keys.js';

describe('single-table key helpers', () => {
  it('module key', () => {
    expect(KEY.module('m1')).toEqual({ PK: 'MODULE#m1', SK: 'META' });
  });

  it('user key', () => {
    expect(KEY.user('u1')).toEqual({ PK: 'USER#u1', SK: 'META' });
  });

  it('assignment key', () => {
    expect(KEY.assignment('u1', 'm1')).toEqual({ PK: 'USER#u1', SK: 'ASSIGN#m1' });
  });

  it('document key', () => {
    expect(KEY.document('d1')).toEqual({ PK: 'DOC#d1', SK: 'META' });
  });

  it('reviewRecord key', () => {
    expect(KEY.reviewRecord('d1', 'u1')).toEqual({ PK: 'DOC#d1', SK: 'RECORD#u1' });
  });

  it('annotation key uses record partition', () => {
    expect(KEY.annotation('d1', 'u1', 'a1')).toEqual({
      PK: 'RECORD#d1#u1',
      SK: 'ANNO#a1',
    });
  });

  it('sectionVerdict key', () => {
    expect(KEY.sectionVerdict('d1', 'u1', 's1')).toEqual({
      PK: 'RECORD#d1#u1',
      SK: 'VERDICT#s1',
    });
  });

  it('auditLog key', () => {
    expect(KEY.auditLog('2026-01-01', '2026-01-01T00:00:00Z', 'id1')).toEqual({
      PK: 'AUDIT#2026-01-01',
      SK: 'TS#2026-01-01T00:00:00Z#id1',
    });
  });

  it('recordPartition composes docId and reviewerId', () => {
    expect(recordPartition('d1', 'u1')).toBe('RECORD#d1#u1');
  });

  it('GSI1 document by module', () => {
    expect(GSI1.documentByModule('m1', 'd1')).toEqual({
      GSI1PK: 'MODULE#m1',
      GSI1SK: 'DOC#d1',
    });
  });

  it('GSI1 assignment by module', () => {
    expect(GSI1.assignmentByModule('m1', 'u1')).toEqual({
      GSI1PK: 'MODULE#m1',
      GSI1SK: 'ASSIGN#u1',
    });
  });

  it('GSI2 record by reviewer', () => {
    expect(GSI2.recordByReviewer('u1', 'd1')).toEqual({
      GSI2PK: 'USER#u1',
      GSI2SK: 'RECORD#d1',
    });
  });

  it('SK prefixes are stable', () => {
    expect(SK_PREFIX.record).toBe('RECORD#');
    expect(SK_PREFIX.assignment).toBe('ASSIGN#');
    expect(SK_PREFIX.annotation).toBe('ANNO#');
    expect(SK_PREFIX.verdict).toBe('VERDICT#');
  });
});
