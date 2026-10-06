import { describe, it, expect } from 'vitest';
import {
  DocumentStatus,
  ReviewRecordStatus,
  Permission,
  Verdict,
  ApprovalPolicy,
  ClassificationSource,
  UserRole,
} from './enums.js';

describe('domain enums', () => {
  it('DocumentStatus has all expected values', () => {
    expect(DocumentStatus.PENDING_CONTENT).toBe('pending_content');
    expect(DocumentStatus.CLASSIFYING).toBe('classifying');
    expect(DocumentStatus.CLASSIFIED).toBe('classified');
    expect(DocumentStatus.NEEDS_MANUAL_CLASSIFICATION).toBe('needs_manual_classification');
    expect(DocumentStatus.CLASSIFICATION_FAILED).toBe('classification_failed');
    expect(DocumentStatus.IN_REVIEW).toBe('in_review');
    expect(DocumentStatus.APPROVED).toBe('approved');
    expect(DocumentStatus.REJECTED).toBe('rejected');
    expect(Object.keys(DocumentStatus)).toHaveLength(8);
  });

  it('ReviewRecordStatus has pending and completed', () => {
    expect(ReviewRecordStatus.PENDING).toBe('pending');
    expect(ReviewRecordStatus.COMPLETED).toBe('completed');
    expect(Object.keys(ReviewRecordStatus)).toHaveLength(2);
  });

  it('Permission has read and edit', () => {
    expect(Permission.READ).toBe('read');
    expect(Permission.EDIT).toBe('edit');
    expect(Object.keys(Permission)).toHaveLength(2);
  });

  it('Verdict has correct and incorrect', () => {
    expect(Verdict.CORRECT).toBe('correct');
    expect(Verdict.INCORRECT).toBe('incorrect');
    expect(Object.keys(Verdict)).toHaveLength(2);
  });

  it('ApprovalPolicy has all and any', () => {
    expect(ApprovalPolicy.ALL).toBe('all');
    expect(ApprovalPolicy.ANY).toBe('any');
    expect(Object.keys(ApprovalPolicy)).toHaveLength(2);
  });

  it('ClassificationSource has ai and manual', () => {
    expect(ClassificationSource.AI).toBe('ai');
    expect(ClassificationSource.MANUAL).toBe('manual');
    expect(Object.keys(ClassificationSource)).toHaveLength(2);
  });

  it('UserRole has admin and revisor', () => {
    expect(UserRole.ADMIN).toBe('admin');
    expect(UserRole.REVIEWER).toBe('revisor');
    expect(Object.keys(UserRole)).toHaveLength(2);
  });
});
