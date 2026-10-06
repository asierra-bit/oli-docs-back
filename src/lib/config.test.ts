import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from './config.js';

describe('getConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  it('returns sensible defaults when no env vars are set', () => {
    const cfg = getConfig();
    expect(cfg.aiProvider).toBe('bedrock');
    expect(cfg.aiConfidenceThreshold).toBe(0.7);
    expect(cfg.schedulingWindowDays).toBe(7);
    expect(cfg.wordsPerMin).toBe(200);
    expect(cfg.minReviewMinutes).toBe(15);
    expect(cfg.maxReviewMinutes).toBe(120);
    expect(cfg.defaultApprovalPolicy).toBe('all');
    expect(cfg.reviewTimeoutDays).toBe(7);
    expect(cfg.maxUploadSizeBytes).toBe(5 * 1024 * 1024); // 5 MB
  });

  it('reads config from env vars', () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_CONFIDENCE_THRESHOLD = '0.85';
    process.env.REVIEW_TIMEOUT_DAYS = '14';
    process.env.MAX_UPLOAD_SIZE_MB = '10';
    process.env.DEFAULT_APPROVAL_POLICY = 'any';

    const cfg = getConfig();
    expect(cfg.aiProvider).toBe('openai');
    expect(cfg.aiConfidenceThreshold).toBe(0.85);
    expect(cfg.reviewTimeoutDays).toBe(14);
    expect(cfg.maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(cfg.defaultApprovalPolicy).toBe('any');
  });

  it('falls back to default on non-numeric env values', () => {
    process.env.WORDS_PER_MIN = 'not-a-number';
    const cfg = getConfig();
    expect(cfg.wordsPerMin).toBe(200);
  });

  it('caches config across calls', () => {
    const first = getConfig();
    process.env.AI_PROVIDER = 'openrouter';
    const second = getConfig();
    expect(second).toBe(first); // same reference
    expect(second.aiProvider).toBe(first.aiProvider); // not re-read
  });

  it('resetConfig clears cache', () => {
    getConfig();
    process.env.AI_PROVIDER = 'openrouter';
    resetConfig();
    const cfg = getConfig();
    expect(cfg.aiProvider).toBe('openrouter');
  });
});
