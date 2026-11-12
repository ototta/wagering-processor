
import { MikroORM } from '@mikro-orm/postgresql';
import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

import { mikroOrmConfig } from '../database/mikro-orm.config';
import { Wallet } from '../wallets/wallet.entity';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.entity';
import { InboxMessage } from './inbox-message.entity';
import { OutboxEvent } from './outbox-event.entity';
import { WagerTransaction } from './wager-transaction.entity';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

describe('Outbox Publisher integration', () => {
  const orms: MikroORM[] = [];

  let queryOrm: MikroORM;
  let originalQueueUrl: string | undefined;

  beforeAll(async () => {
    originalQueueUrl = process.env.SQS_QUEUE_URL;
    process.env.SQS_QUEUE_URL =
      'http://localhost:4566/000000000000/wager-transactions.fifo';

    const config = {
      ...mikroOrmConfig,
      entities: [
        Wallet,
        WagerTransaction,
        WalletLedgerEntry,
        InboxMessage,
        OutboxEvent,
      ],
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: Number(process.env.DATABASE_PORT ?? 5433),
      dbName: process.env.DATABASE_NAME ?? 'wagering_processor',
      user: process.env.DATABASE_USER ?? 'postgres',
      password: process.env.DATABASE_PASSWORD ?? 'postgres',
    };

    for (let i = 0; i < 2; i++) {
      const orm = await MikroORM.init(config);
      orms.push(orm);
    }

    queryOrm = orms[0];
  });

  afterAll(async () => {
    await Promise.all(
      orms.map((orm) => orm.close(true)),
    );

    if (originalQueueUrl === undefined) {
      delete process.env.SQS_QUEUE_URL;
    } else {
      process.env.SQS_QUEUE_URL = originalQueueUrl;
    }
  });

  function createSqsMock(
    implementation?: (
      command: SendMessageCommand,
    ) => Promise<unknown>,
  ): {
    client: SQSClient;
    send: jest.Mock;
  } {
    const send = jest.fn(
      implementation ??
        (async (_command: SendMessageCommand) => {
          await new Promise((resolve) =>
            setTimeout(resolve, 100),
          );

          return {
            MessageId: randomUUID(),
          };
        }),
    );

    return {
      client: {
        send,
      } as unknown as SQSClient,
      send,
    };
  }

  async function createOutboxEvent(
    aggregateId: string,
  ): Promise<string> {
    const eventId = randomUUID();

    await queryOrm.em.execute(
      `
        INSERT INTO outbox_events (
          id,
          aggregate_id,
          event_type,
          payload,
          status,
          attempts,
          available_at,
          created_at
        )
        VALUES (
          ?,
          ?,
          'WagerTransactionProcessed',
          ?::jsonb,
          'PENDING',
          0,
          NOW(),
          NOW()
        )
      `,
      [
        eventId,
        aggregateId,
        JSON.stringify({
          transactionId: aggregateId,
          status: 'PROCESSED',
        }),
      ],
    );

    return eventId;
  }

  async function getOutboxStatus(
    eventId: string,
  ): Promise<{
    status: string;
    attempts: number;
    lock_token: string | null;
    locked_until: Date | null;
    last_error: string | null;
    available_at: Date;
  }> {
    const rows = (await queryOrm.em.execute(
      `
        SELECT
          status,
          attempts,
          lock_token,
          locked_until,
          last_error,
          available_at
        FROM outbox_events
        WHERE id = ?
      `,
      [eventId],
    )) as Array<{
      status: string;
      attempts: number;
      lock_token: string | null;
      locked_until: Date | null;
      last_error: string | null;
      available_at: Date;
    }>;

    return rows[0];
  }

  async function deleteOutboxEvent(
    eventId: string,
  ): Promise<void> {
    await queryOrm.em.execute(
      `
        DELETE FROM outbox_events
        WHERE id = ?
      `,
      [eventId],
    );
  }

  it(
    'deve impedir que duas instâncias publiquem o mesmo evento simultaneamente',
    async () => {
      const aggregateId = randomUUID();
      const eventId = await createOutboxEvent(aggregateId);

      const sqsMock = createSqsMock();

      const publisherOne = new OutboxPublisherWorker(
        orms[0].em.fork(),
        sqsMock.client,
      );

      const publisherTwo = new OutboxPublisherWorker(
        orms[1].em.fork(),
        sqsMock.client,
      );

      try {
        const results = await Promise.all([
          publisherOne.publishPendingEvents(aggregateId),
          publisherTwo.publishPendingEvents(aggregateId),
        ]);

        const totalPublished = results.reduce(
          (total, current) => total + current,
          0,
        );

        const databaseEvent = await getOutboxStatus(eventId);

        expect(totalPublished).toBe(1);
        expect(sqsMock.send).toHaveBeenCalledTimes(1);
        expect(databaseEvent.status).toBe('PUBLISHED');
        expect(databaseEvent.attempts).toBe(1);
        expect(databaseEvent.lock_token).toBeNull();
        expect(databaseEvent.locked_until).toBeNull();
      } finally {
        await deleteOutboxEvent(eventId);
      }
    },
  );

  it(
    'deve recuperar e publicar um evento com lease expirado',
    async () => {
      const aggregateId = randomUUID();
      const eventId = await createOutboxEvent(aggregateId);

      const previousLockToken = randomUUID();

      await queryOrm.em.execute(
        `
          UPDATE outbox_events
          SET
            status = 'PROCESSING',
            attempts = 1,
            lock_token = ?,
            locked_until = NOW() - INTERVAL '1 minute'
          WHERE id = ?
        `,
        [previousLockToken, eventId],
      );

      const sqsMock = createSqsMock();

      const publisher = new OutboxPublisherWorker(
        orms[0].em.fork(),
        sqsMock.client,
      );

      try {
        const published =
          await publisher.publishPendingEvents(aggregateId);

        const databaseEvent = await getOutboxStatus(eventId);

        expect(published).toBe(1);
        expect(sqsMock.send).toHaveBeenCalledTimes(1);
        expect(databaseEvent.status).toBe('PUBLISHED');
        expect(databaseEvent.attempts).toBe(2);
        expect(databaseEvent.lock_token).toBeNull();
        expect(databaseEvent.locked_until).toBeNull();
      } finally {
        await deleteOutboxEvent(eventId);
      }
    },
  );

  it(
    'deve liberar o lease e agendar nova tentativa quando o SQS falhar',
    async () => {
      const aggregateId = randomUUID();
      const eventId = await createOutboxEvent(aggregateId);

      const sqsMock = createSqsMock(
        async () => {
          throw new Error('Falha simulada no SQS');
        },
      );

      const publisher = new OutboxPublisherWorker(
        orms[0].em.fork(),
        sqsMock.client,
      );

      try {
        const published =
          await publisher.publishPendingEvents(aggregateId);

        const databaseEvent = await getOutboxStatus(eventId);

        expect(published).toBe(0);
        expect(sqsMock.send).toHaveBeenCalledTimes(1);
        expect(databaseEvent.status).toBe('PENDING');
        expect(databaseEvent.attempts).toBe(1);
        expect(databaseEvent.lock_token).toBeNull();
        expect(databaseEvent.locked_until).toBeNull();
        expect(databaseEvent.last_error).toContain(
          'Falha simulada no SQS',
        );

        expect(
          new Date(databaseEvent.available_at).getTime(),
        ).toBeGreaterThan(Date.now());
      } finally {
        await deleteOutboxEvent(eventId);
      }
    },
  );
});
