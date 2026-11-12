
import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WageringProcessorService } from './wagering-processor.service';
import { PendingReferenceWorker } from './pending-reference.worker';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { SqsConsumerWorker } from './sqs-consumer.worker';

@Module({
  providers: [
    WageringProcessorService,
    PendingReferenceWorker,
    OutboxPublisherWorker,
    SqsConsumerWorker,
    {
      provide: SQSClient,
      useFactory: () => {
        const endpoint = process.env.SQS_ENDPOINT;

        return new SQSClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          ...(endpoint
            ? {
                endpoint,
                credentials: {
                  accessKeyId:
                    process.env.AWS_ACCESS_KEY_ID ?? 'test',
                  secretAccessKey:
                    process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
                },
              }
            : {}),
        });
      },
    },
  ],
  exports: [WageringProcessorService],
})
export class WageringModule {}
