import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { DocumentStore } from './document-store.js';
import { NotFoundError, UpstreamError } from '../../lib/errors.js';

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: vi.fn().mockResolvedValue({
    url: 'https://signed.example/upload',
    fields: { key: 'documents/abc.md', 'Content-Type': 'text/markdown' },
  }),
}));

const presignedMock = vi.mocked(createPresignedPost);
const s3Mock = mockClient(S3Client);

describe('DocumentStore', () => {
  let store: DocumentStore;

  beforeEach(() => {
    s3Mock.reset();
    presignedMock.mockClear();
    store = new DocumentStore('my-bucket', { client: new S3Client({}) });
  });

  it('buildKey produces documents/<docId>.md', () => {
    expect(store.buildKey('abc')).toBe('documents/abc.md');
  });

  it('parseDocId is the inverse of buildKey', () => {
    expect(DocumentStore.parseDocId('documents/abc.md')).toBe('abc');
    expect(DocumentStore.parseDocId('documents%2Fabc.md')).toBe('abc');
    expect(DocumentStore.parseDocId('other/thing.txt')).toBeNull();
  });

  it('createUpload returns key, presigned url and fields', async () => {
    const result = await store.createUpload('abc');
    expect(result.key).toBe('documents/abc.md');
    expect(result.url).toBe('https://signed.example/upload');
    expect(result.fields['Content-Type']).toBe('text/markdown');
  });

  it('createUpload enforces a content-length-range using the given maxBytes', async () => {
    await store.createUpload('abc', { maxBytes: 1024 });
    const args = presignedMock.mock.calls[0]![1];
    expect(args.Conditions).toContainEqual(['content-length-range', 0, 1024]);
    expect(args.Fields).toMatchObject({ 'Content-Type': 'text/markdown' });
  });

  it('createUpload defaults the max size to 5 MB', async () => {
    await store.createUpload('abc');
    const args = presignedMock.mock.calls[0]![1];
    expect(args.Conditions).toContainEqual(['content-length-range', 0, 5 * 1024 * 1024]);
  });

  it('readContent returns the object body as string', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => '# Hello',
      } as never,
    });
    const content = await store.readContent('documents/abc.md');
    expect(content).toBe('# Hello');
  });

  it('readContent throws UpstreamError when body is empty', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: undefined });
    await expect(store.readContent('documents/x.md')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('readContent maps a missing object to NotFoundError (404)', async () => {
    const err = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
    });
    s3Mock.on(GetObjectCommand).rejects(err);
    await expect(store.readContent('documents/x.md')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('readContent wraps other SDK errors in UpstreamError (502)', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('connection reset'));
    await expect(store.readContent('documents/x.md')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('deleteContent issues a DeleteObjectCommand', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await store.deleteContent('documents/abc.md');
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});
