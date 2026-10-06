import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { AnnotationRepo } from './annotation-repo.js';
import type { Annotation, SectionVerdict } from '../../domain/entities.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'TestTable';

function makeRepo() {
  return new AnnotationRepo(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
}

const annotation: Annotation = {
  id: 'a1',
  documentId: 'd1',
  reviewerId: 'u1',
  target: { type: 'document' },
  text: 'overall ok',
  createdAt: '2026-01-01T00:00:00Z',
};

const verdict: SectionVerdict = {
  documentId: 'd1',
  reviewerId: 'u1',
  sectionId: 's1',
  verdict: 'incorrect',
};

describe('AnnotationRepo', () => {
  beforeEach(() => ddbMock.reset());

  it('putAnnotation persists', async () => {
    ddbMock.on(PutCommand).resolves({});
    expect(await makeRepo().putAnnotation(annotation)).toEqual(annotation);
  });

  it('listAnnotations queries record partition with ANNO prefix', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...annotation, _type: 'Annotation' }] });
    const result = await makeRepo().listAnnotations('d1', 'u1');
    expect(result).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'RECORD#d1#u1',
      ':prefix': 'ANNO#',
    });
  });

  it('deleteAnnotation removes item', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await makeRepo().deleteAnnotation('d1', 'u1', 'a1');
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it('putSectionVerdict persists', async () => {
    ddbMock.on(PutCommand).resolves({});
    expect(await makeRepo().putSectionVerdict(verdict)).toEqual(verdict);
  });

  it('listSectionVerdicts queries with VERDICT prefix', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...verdict, _type: 'SectionVerdict' }] });
    const result = await makeRepo().listSectionVerdicts('d1', 'u1');
    expect(result[0]!.verdict).toBe('incorrect');
    const call = ddbMock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':prefix': 'VERDICT#',
    });
  });
});


