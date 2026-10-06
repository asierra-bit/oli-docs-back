import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/**
 * Thin SQS producer used by workers to hand off to the next stage
 * (classification → scheduling). Kept behind an interface so services/handlers
 * can be tested with a fake.
 */
export interface QueueSender {
  send(body: unknown): Promise<void>;
}

export class SqsQueueSender implements QueueSender {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    options?: { region?: string; client?: SQSClient },
  ) {
    this.client = options?.client ?? new SQSClient({ region: options?.region });
  }

  async send(body: unknown): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(body),
      }),
    );
  }
}

/** Message shape handed to the scheduling queue. */
export interface SchedulingMessage {
  documentId: string;
}
