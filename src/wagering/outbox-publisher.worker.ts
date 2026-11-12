
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

interface OutboxCandidate {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
}

interface ClaimedOutboxEvent extends OutboxCandidate {
  lockToken: string;
}

@Injectable()
export class OutboxPublisherWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisherWorker.name);

  private readonly queueUrl = process.env.SQS_QUEUE_URL;

  private readonly batchSize = 10;
  private readonly intervalMs = 2000;
  private readonly leaseSeconds = 120;
  private readonly maxAttempts = 10;

  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private currentCycle: Promise<void> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
  ) {}

  onModuleInit(): void {
    if (!this.queueUrl) {
      this.logger.warn(
        'Outbox Publisher desativado: SQS_QUEUE_URL não configurada.',
      );
      return;
    }

    void this.runCycle();

    this.interval = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.currentCycle) {
      await this.currentCycle;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    this.currentCycle = this.publishPendingEvents()
      .then((published) => {
        if (published > 0) {
          this.logger.log(
            `${published} evento(s) publicado(s) no SQS.`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Erro no ciclo de publicação do Outbox.',
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.isRunning = false;
        this.currentCycle = null;
      });

    await this.currentCycle;
  }

  async publishPendingEvents(
    aggregateId?: string,
  ): Promise<number> {
    if (!this.queueUrl) {
      throw new Error('SQS_QUEUE_URL não configurada.');
    }

    const events = await this.claimBatch(aggregateId);

    let published = 0;

    for (const event of events) {
      const success = await this.publishEvent(event);

      if (success) {
        published++;
      }
    }

    return published;
  }

  private async claimBatch(
    aggregateId?: string,
  ): Promise<ClaimedOutboxEvent[]> {
    return this.em.transactional(async (tx) => {
      const candidates = await tx.execute<OutboxCandidate[]>(
        `
          SELECT
            o.id,
            o.aggregate_id,
            o.event_type,
            o.payload,
            o.attempts,
            o.created_at
          FROM outbox_events o
          WHERE (
            (
              o.status = 'PENDING'
              AND o.available_at <= NOW()
            )
            OR
            (
              o.status = 'PROCESSING'
              AND (
                o.locked_until IS NULL
                OR o.locked_until <= NOW()
              )
            )
          )
          AND (?::uuid IS NULL OR o.aggregate_id = ?::uuid)
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_events earlier
            WHERE earlier.aggregate_id = o.aggregate_id
              AND (
                earlier.created_at < o.created_at
                OR (
                  earlier.created_at = o.created_at
                  AND earlier.id < o.id
                )
              )
              AND earlier.status IN ('PENDING', 'PROCESSING')
          )
          ORDER BY o.available_at, o.created_at, o.id
          LIMIT ?
          FOR UPDATE OF o SKIP LOCKED
        `,
        [
          aggregateId ?? null,
          aggregateId ?? null,
          this.batchSize,
        ],
      );

      const claimed: ClaimedOutboxEvent[] = [];

      for (const candidate of candidates) {
        const lockToken = randomUUID();

        await tx.execute(
          `
            UPDATE outbox_events
            SET
              status = 'PROCESSING',
              attempts = attempts + 1,
              lock_token = ?,
              locked_until = NOW() + (? * INTERVAL '1 second')
            WHERE id = ?
          `,
          [
            lockToken,
            this.leaseSeconds,
            candidate.id,
          ],
        );

        claimed.push({
          ...candidate,
          attempts: candidate.attempts + 1,
          lockToken,
        });
      }

      return claimed;
    });
  }

  private async publishEvent(
    event: ClaimedOutboxEvent,
  ): Promise<boolean> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify({
            eventId: event.id,
            aggregateId: event.aggregate_id,
            eventType: event.event_type,
            payload: event.payload,
            createdAt: event.created_at,
          }),
          MessageGroupId: event.aggregate_id,
          MessageDeduplicationId: event.id,
        }),
      );
    } catch (error) {
      await this.scheduleRetry(event, error);
      return false;
    }

    const updated = await this.em.execute<Array<{ id: string }>>(
      `
        UPDATE outbox_events
        SET
          status = 'PUBLISHED',
          published_at = NOW(),
          lock_token = NULL,
          locked_until = NULL,
          last_error = NULL
        WHERE id = ?
          AND status = 'PROCESSING'
          AND lock_token = ?
        RETURNING id
      `,
      [event.id, event.lockToken],
    );

    if (updated.length === 0) {
      this.logger.warn(
        `Evento ${event.id} enviado, mas a posse do lease foi perdida antes da confirmação.`,
      );

      return false;
    }

    return true;
  }

  private async scheduleRetry(
    event: ClaimedOutboxEvent,
    error: unknown,
  ): Promise<void> {
    const delaySeconds = Math.min(
      30 * 2 ** (event.attempts - 1),
      3600,
    );

    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error);

    const status =
      event.attempts >= this.maxAttempts
        ? 'FAILED'
        : 'PENDING';

    await this.em.execute(
      `
        UPDATE outbox_events
        SET
          status = ?,
          available_at = NOW() + (? * INTERVAL '1 second'),
          lock_token = NULL,
          locked_until = NULL,
          last_error = ?
        WHERE id = ?
          AND status = 'PROCESSING'
          AND lock_token = ?
      `,
      [
        status,
        delaySeconds,
        errorMessage.slice(0, 4000),
        event.id,
        event.lockToken,
      ],
    );

    if (status === 'FAILED') {
      this.logger.error(
        `Evento ${event.id} atingiu o limite de tentativas e foi marcado como FAILED.`,
      );
      return;
    }

    this.logger.warn(
      `Falha ao publicar evento ${event.id}. Nova tentativa em ${delaySeconds}s.`,
    );
  }
}
