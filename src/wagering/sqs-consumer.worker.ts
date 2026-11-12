
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import {
  ProcessBetInput,
  ProcessReversalInput,
  WageringProcessorService,
} from './wagering-processor.service';

type IncomingTransactionType =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

interface IncomingTransaction {
  type: IncomingTransactionType;
  data: ProcessBetInput | ProcessReversalInput;
}

@Injectable()
export class SqsConsumerWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SqsConsumerWorker.name);
  private readonly queueUrl = process.env.SQS_INBOUND_QUEUE_URL;
  private readonly waitTimeSeconds = 20;
  private readonly visibilityTimeout = 60;
  private readonly maxMessages = 10;
  private interval: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private isStopping = false;
  private currentCycle: Promise<void> | null = null;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processor: WageringProcessorService,
  ) {}

  onModuleInit(): void {
    if (!this.queueUrl) {
      this.logger.warn(
        'SQS Consumer desativado: SQS_INBOUND_QUEUE_URL não configurada.',
      );
      return;
    }

    void this.scheduleNextCycle();
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopping = true;

    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
    }

    if (this.currentCycle) {
      await this.currentCycle;
    }
  }

  private async scheduleNextCycle(): Promise<void> {
    if (this.isStopping || !this.queueUrl) return;

    this.currentCycle = this.runCycle();
    await this.currentCycle;
    this.currentCycle = null;

    if (!this.isStopping) {
      this.interval = setTimeout(() => {
        void this.scheduleNextCycle();
      }, 250);
    }
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning || !this.queueUrl) return;

    this.isRunning = true;

    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: this.maxMessages,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: this.visibilityTimeout,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (this.isStopping) break;
        await this.processMessage(message);
      }
    } catch (error) {
      this.logger.error(
        'Erro ao receber mensagens do SQS.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async processMessage(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) {
      this.logger.error(
        `Mensagem SQS inválida: ${message.MessageId ?? 'sem ID'}.`,
      );
      return;
    }

    try {
      const transaction = this.parseMessage(message.Body);
      await this.dispatch(transaction);

      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );

      this.logger.log(
        `Mensagem ${message.MessageId ?? 'sem ID'} processada e confirmada.`,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao processar mensagem ${message.MessageId ?? 'sem ID'}. Ela ficará disponível para nova tentativa.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private parseMessage(body: string): IncomingTransaction {
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('INVALID_MESSAGE_JSON');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      !('data' in parsed)
    ) {
      throw new Error('INVALID_MESSAGE_FORMAT');
    }

    const candidate = parsed as Record<string, unknown>;

    const allowedTypes: IncomingTransactionType[] = [
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK',
    ];

    if (
      typeof candidate.type !== 'string' ||
      !allowedTypes.includes(candidate.type as IncomingTransactionType)
    ) {
      throw new Error('INVALID_TRANSACTION_TYPE');
    }

    if (
      typeof candidate.data !== 'object' ||
      candidate.data === null ||
      Array.isArray(candidate.data)
    ) {
      throw new Error('INVALID_TRANSACTION_DATA');
    }

    const data = candidate.data as Record<string, unknown>;

    const requiredFields = [
      'walletId',
      'providerId',
      'externalTransactionId',
      'roundId',
      'amount',
    ];

    for (const field of requiredFields) {
      if (
        typeof data[field] !== 'string' ||
        data[field].trim().length === 0
      ) {
        throw new Error(`INVALID_FIELD_${field.toUpperCase()}`);
      }
    }

    if (
      data.idempotencyKey !== undefined &&
      typeof data.idempotencyKey !== 'string'
    ) {
      throw new Error('INVALID_FIELD_IDEMPOTENCY_KEY');
    }

    if (
      candidate.type === 'REFUND' ||
      candidate.type === 'ROLLBACK'
    ) {
      if (
        typeof data.referenceTransactionId !== 'string' ||
        data.referenceTransactionId.trim().length === 0
      ) {
        throw new Error('REFERENCE_TRANSACTION_ID_REQUIRED');
      }
    }

    return {
      type: candidate.type as IncomingTransactionType,
      data: data as unknown as ProcessBetInput | ProcessReversalInput,
    };
  }

  private async dispatch(
    transaction: IncomingTransaction,
  ): Promise<void> {
    switch (transaction.type) {
      case 'BET':
        await this.processor.processBet(
          transaction.data as ProcessBetInput,
        );
        return;

      case 'WIN':
        await this.processor.processWin(
          transaction.data as ProcessBetInput,
        );
        return;

      case 'LOSS':
        await this.processor.processLoss(
          transaction.data as ProcessBetInput,
        );
        return;

      case 'REFUND':
        await this.processor.processRefund(
          transaction.data as ProcessReversalInput,
        );
        return;

      case 'ROLLBACK':
        await this.processor.processRollback(
          transaction.data as ProcessReversalInput,
        );
        return;
    }
  }
}
