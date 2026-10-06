/**
 * Application configuration loaded from environment variables.
 *
 * In Lambda, values come from env vars set by CDK (with SSM-resolved values).
 * Defaults are provided for local development and tests.
 */

export interface AppConfig {
  /** AI provider to use: 'bedrock' | 'openai' | 'openrouter'. */
  aiProvider: string;
  /** Confidence threshold (0..1) below which classification is manual. */
  aiConfidenceThreshold: number;
  /** Model identifier for the selected AI provider (optional override). */
  aiModel?: string;
  /** Secrets Manager id holding the API key for OpenAI/OpenRouter. */
  aiApiKeySecretId?: string;
  /** Max classification attempts before marking classification_failed. */
  aiMaxAttempts: number;
  /** Scheduling window in days to search for free slots. */
  schedulingWindowDays: number;
  /** Estimated words a reviewer reads per minute. */
  wordsPerMin: number;
  /** Minimum review block duration in minutes. */
  minReviewMinutes: number;
  /** Maximum review block duration in minutes. */
  maxReviewMinutes: number;
  /** Default approval policy when none is specified. */
  defaultApprovalPolicy: 'all' | 'any';
  /** Days after which a pending review record is considered expired. */
  reviewTimeoutDays: number;
  /** Maximum upload size in bytes for .md files. */
  maxUploadSizeBytes: number;
  /** DynamoDB table name. */
  tableName: string;
  /** S3 bucket name for document content. */
  bucketName: string;
  /** Cognito User Pool id for admin user operations. */
  userPoolId: string;
  /** SQS URL for the scheduling queue. */
  schedulingQueueUrl: string;
  /** Google OAuth client id. */
  googleClientId: string;
  /** Secrets Manager id holding the Google OAuth client secret. */
  googleClientSecretId: string;
  /** OAuth redirect URI registered with Google. */
  googleRedirectUri: string;
  /** AWS region. */
  region: string;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

let _config: AppConfig | null = null;

/** Load (or return cached) application config from environment variables. */
export function getConfig(): AppConfig {
  if (_config) return _config;

  const maxUploadMB = envInt('MAX_UPLOAD_SIZE_MB', 5);

  _config = {
    aiProvider: envStr('AI_PROVIDER', 'bedrock'),
    aiConfidenceThreshold: envFloat('AI_CONFIDENCE_THRESHOLD', 0.7),
    aiModel: process.env.AI_MODEL,
    aiApiKeySecretId: process.env.AI_API_KEY_SECRET_ID,
    aiMaxAttempts: envInt('AI_MAX_ATTEMPTS', 3),
    schedulingWindowDays: envInt('SCHEDULING_WINDOW_DAYS', 7),
    wordsPerMin: envInt('WORDS_PER_MIN', 200),
    minReviewMinutes: envInt('MIN_REVIEW_MINUTES', 15),
    maxReviewMinutes: envInt('MAX_REVIEW_MINUTES', 120),
    defaultApprovalPolicy: envStr('DEFAULT_APPROVAL_POLICY', 'all') as 'all' | 'any',
    reviewTimeoutDays: envInt('REVIEW_TIMEOUT_DAYS', 7),
    maxUploadSizeBytes: maxUploadMB * 1024 * 1024,
    tableName: envStr('TABLE_NAME', 'AppTable'),
    bucketName: envStr('BUCKET_NAME', 'oli-docs-bucket'),
    userPoolId: envStr('USER_POOL_ID', 'local-user-pool'),
    schedulingQueueUrl: envStr('SCHEDULING_QUEUE_URL', ''),
    googleClientId: envStr('GOOGLE_CLIENT_ID', ''),
    googleClientSecretId: envStr('GOOGLE_CLIENT_SECRET_ID', ''),
    googleRedirectUri: envStr('GOOGLE_REDIRECT_URI', ''),
    region: envStr('AWS_REGION', 'us-east-1'),
  };

  return _config;
}

/** Reset cached config — only for tests. */
export function resetConfig(): void {
  _config = null;
}
