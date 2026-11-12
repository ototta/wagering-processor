
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';

import { mikroOrmConfig } from '../database/mikro-orm.config';
import { Wallet } from '../wallets/wallet.entity';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.entity';
import { InboxMessage } from './inbox-message.entity';
import { OutboxEvent } from './outbox-event.entity';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from './wager-transaction.entity';
import { WageringProcessorService } from './wagering-processor.service';

describe('Multiple instances integration', () => {
  const orms: MikroORM[] = [];
  const processors: WageringProcessorService[] = [];

  let queryOrm: MikroORM;

  beforeAll(async () => {
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

    for (let i = 0; i < 3; i++) {
      const orm = await MikroORM.init(config);

      orms.push(orm);
      processors.push(new WageringProcessorService(orm.em));
    }

    queryOrm = orms[0];
  });

  afterAll(async () => {
    await Promise.all(
      orms.map((orm) => orm.close(true)),
    );
  });

  async function createWallet(balance: string): Promise<string> {
    const walletId = randomUUID();

    await queryOrm.em.execute(
      `
        INSERT INTO wallets (
          id,
          player_id,
          currency,
          balance,
          created_at,
          updated_at
        )
        VALUES (?, ?, 'BRL', ?::numeric, NOW(), NOW())
      `,
      [walletId, randomUUID(), balance],
    );

    return walletId;
  }

  async function getBalance(walletId: string): Promise<string> {
    const rows = (await queryOrm.em.execute(
      `
        SELECT balance
        FROM wallets
        WHERE id = ?
      `,
      [walletId],
    )) as Array<{ balance: string }>;

    return rows[0].balance;
  }

  async function getBetLedgerCount(walletId: string): Promise<number> {
    const rows = (await queryOrm.em.execute(
      `
        SELECT COUNT(*)::int AS total
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
          AND type = 'BET'
      `,
      [walletId],
    )) as Array<{ total: number }>;

    return Number(rows[0].total);
  }

  it('deve manter a consistência financeira com três instâncias simultâneas', async () => {
    const walletId = await createWallet('100.00');

    const results = await Promise.all(
      processors.map((processor) =>
        processor.processBet({
          walletId,
          providerId: 'provider-test',
          externalTransactionId: randomUUID(),
          roundId: 'round-test',
          amount: '40.00',
        }),
      ),
    );

    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.PROCESSED,
    );

    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.REJECTED,
    );

    expect(processed).toHaveLength(2);
    expect(rejected).toHaveLength(1);

    expect(await getBalance(walletId)).toBe('20.00');
    expect(await getBetLedgerCount(walletId)).toBe(2);
  });
});
