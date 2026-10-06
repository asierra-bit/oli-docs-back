import { GetObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { NotFoundError, UpstreamError } from '../../lib/errors.js';

/** Default maximum upload size (5 MB) when none is supplied. */
const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * S3 storage for Markdown document content.
 *
 * Keys follow `documents/<docId>.md`. Uploads use a presigned POST (not a
 * presigned PUT) so the upload size can be constrained server-side via the
 * `content-length-range` policy condition (R4.2) — a presigned PUT cannot
 * enforce a maximum size at the signature level.
 */
export class DocumentStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options?: { region?: string; client?: S3Client },
  ) {
    this.client = options?.client ?? new S3Client({ region: options?.region });
  }

  /** Build the deterministic S3 key for a document's content. */
  buildKey(docId: string): string {
    return `documents/${docId}.md`;
  }

  /** Reverse of {@link buildKey}: extract the docId from an S3 key, or null. */
  static parseDocId(key: string): string | null {
    const match = /^documents\/(.+)\.md$/.exec(decodeURIComponent(key));
    return match ? match[1]! : null;
  }

  /**
   * Generate a presigned POST for uploading the document content.
   *
   * The returned `{ url, fields }` must be used as a multipart/form-data POST
   * with the file appended last. The policy enforces:
   *  - a maximum size via `content-length-range` (0..maxBytes), and
   *  - the fixed key and `text/markdown` content type.
   * The presigned POST expires after `expiresInSeconds` (default 15 min).
   */
  async createUpload(
    docId: string,
    options: { maxBytes?: number; expiresInSeconds?: number } = {},
  ): Promise<{ key: string; url: string; fields: Record<string, string> }> {
    const key = this.buildKey(docId);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const expiresIn = options.expiresInSeconds ?? 900;

    const presigned: PresignedPost = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 0, maxBytes],
        { 'Content-Type': 'text/markdown' },
      ],
      Fields: { 'Content-Type': 'text/markdown' },
      Expires: expiresIn,
    });

    return { key, url: presigned.url, fields: presigned.fields };
  }

  /** Read the full text content of a document from S3. */
  async readContent(key: string): Promise<string> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Distinguish a missing object (404) from other upstream failures (502).
      if (isNoSuchKey(err)) {
        throw new NotFoundError('Document content', key);
      }
      throw new UpstreamError('S3', err instanceof Error ? err.message : String(err));
    }
    if (!res.Body) {
      throw new UpstreamError('S3', `Empty body for key '${key}'`);
    }
    // Body is a stream in Node — transformToString is provided by the SDK.
    return await res.Body.transformToString('utf-8');
  }

  /** Delete a document's content (used on cleanup). */
  async deleteContent(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** True if an S3 SDK error indicates the object does not exist. */
function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
