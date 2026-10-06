import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsQueueSender } from './queue-sender.js';

const sqsMock = mockClient(SQSClient);

describe('SqsQueueSender', () => {
  beforeEach(() => sqsMock.reset());

  it('sends a JSON-serialised message to the configured queue', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'x' });
    const sender = new SqsQueueSender('https://sqs/queue', { client: new SQSClient({}) });
    await sender.send({ documentId: 'd1' });

    const call = sqsMock.commandCalls(SendMessageCommand)[0]!;
    expect(call.args[0].input.QueueUrl).toBe('https://sqs/queue');
    expect(JSON.parse(call.args[0].input.MessageBody as string)).toEqual({ documentId: 'd1' });
  });
});
