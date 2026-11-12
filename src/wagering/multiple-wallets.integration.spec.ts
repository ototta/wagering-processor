
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

describe('Multiple wallets integration', () => {
  let orm: MikroORM;
  let processor: WageringProcessorService;

  beforeAll(async () => {
    orm = await MikroORM.init({
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
    });

    processor = new WageringProcessorService(orm.em);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  async function createWallet(balance: string): Promise<string> {
    const walletId = randomUUID();

    await orm.em.execute(
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
    const rows = (await orm.em.execute(
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
    const rows = (await orm.em.execute(
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

  it('deve processar apostas simultâneas em carteiras diferentes', async () => {
    const walletA = await createWallet('100.00');
    const walletB = await createWallet('100.00');

    const [resultA, resultB] = await Promise.all([
      processor.processBet({
        walletId: walletA,
        providerId: 'provider-test',
        externalTransactionId: randomUUID(),
        roundId: 'round-test',
        amount: '80.00',
      }),
      processor.processBet({
        walletId: walletB,
        providerId: 'provider-test',
        externalTransactionId: randomUUID(),
        roundId: 'round-test',
        amount: '80.00',
      }),
    ]);

    expect(resultA.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );

    expect(resultB.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );

    expect(await getBalance(walletA)).toBe('20.00');
    expect(await getBalance(walletB)).toBe('20.00');

    expect(await getBetLedgerCount(walletA)).toBe(1);
    expect(await getBetLedgerCount(walletB)).toBe(1);
  });
});
