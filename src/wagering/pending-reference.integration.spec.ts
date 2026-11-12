
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
  WagerTransactionType,
} from './wager-transaction.entity';
import { WageringProcessorService } from './wagering-processor.service';

describe('Pending references integration', () => {
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

  beforeEach(async () => {
    // Evita que referências antigas de outras execuções
    // interfiram no teste atual.
    await orm.em.execute(`
      UPDATE wager_transactions
      SET reference_next_retry_at = NOW() + INTERVAL '1 day'
      WHERE status = 'PENDING_REFERENCE'
        AND pending_reference_transaction_id IS NOT NULL
    `);
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

  async function createOriginalTransaction(
    walletId: string,
    transactionId: string,
    type: WagerTransactionType,
    amount: string,
    externalTransactionId: string,
  ): Promise<void> {
    await orm.em.execute(
      `
        INSERT INTO wager_transactions (
          id,
          wallet_id,
          provider_id,
          external_transaction_id,
          round_id,
          type,
          status,
          amount,
          currency,
          created_at,
          processed_at
        )
        VALUES (?, ?, 'provider-test', ?, 'round-test', ?, ?, ?::numeric, 'BRL', NOW(), NOW())
      `,
      [
        transactionId,
        walletId,
        externalTransactionId,
        type,
        WagerTransactionStatus.PROCESSED,
        amount,
      ],
    );
  }

  async function makeReferenceDue(transactionId: string): Promise<void> {
    await orm.em.execute(
      `
        UPDATE wager_transactions
        SET reference_next_retry_at = NOW() - INTERVAL '1 second'
        WHERE id = ?
      `,
      [transactionId],
    );
  }

  async function getBalance(walletId: string): Promise<string> {
    const rows = (await orm.em.execute(
      `SELECT balance FROM wallets WHERE id = ?`,
      [walletId],
    )) as Array<{ balance: string }>;

    return rows[0].balance;
  }

  it('deve processar um REFUND quando a BET referenciada aparecer', async () => {
    const walletId = await createWallet('20.00');
    const referenceId = randomUUID();

    const result = await processor.processRefund({
      walletId,
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      roundId: 'round-test',
      amount: '10.00',
      referenceTransactionId: referenceId,
    });

    expect(result.status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );

    await createOriginalTransaction(
      walletId,
      referenceId,
      WagerTransactionType.BET,
      '10.00',
      randomUUID(),
    );

    await makeReferenceDue(result.transactionId);

    const processed = await processor.processPendingReferences();

    expect(processed).toBe(1);
    expect(await getBalance(walletId)).toBe('30.00');

    const transactions = (await orm.em.execute(
      `SELECT status FROM wager_transactions WHERE id = ?`,
      [result.transactionId],
    )) as Array<{ status: WagerTransactionStatus }>;

    expect(transactions[0].status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
  });

  it('deve debitar a carteira ao fazer ROLLBACK de um REFUND pendente', async () => {
    const walletId = await createWallet('40.00');
    const referenceId = randomUUID();

    const result = await processor.processRollback({
      walletId,
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      roundId: 'round-test',
      amount: '10.00',
      referenceTransactionId: referenceId,
    });

    expect(result.status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );

    await createOriginalTransaction(
      walletId,
      referenceId,
      WagerTransactionType.REFUND,
      '10.00',
      randomUUID(),
    );

    await makeReferenceDue(result.transactionId);

    const processed = await processor.processPendingReferences();

    expect(processed).toBe(1);
    expect(await getBalance(walletId)).toBe('30.00');

    const ledger = (await orm.em.execute(
      `
        SELECT amount
        FROM wallet_ledger_entries
        WHERE wager_transaction_id = ?
      `,
      [result.transactionId],
    )) as Array<{ amount: string }>;

    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe('-10.00');
  });

  it('deve agendar nova tentativa quando a referência ainda não existir', async () => {
    const walletId = await createWallet('20.00');

    const result = await processor.processRefund({
      walletId,
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      roundId: 'round-test',
      amount: '10.00',
      referenceTransactionId: randomUUID(),
    });

    await makeReferenceDue(result.transactionId);

    const processed = await processor.processPendingReferences();

    expect(processed).toBe(1);

    const rows = (await orm.em.execute(
      `
        SELECT
          status,
          reference_retry_count,
          reference_next_retry_at
        FROM wager_transactions
        WHERE id = ?
      `,
      [result.transactionId],
    )) as Array<{
      status: WagerTransactionStatus;
      reference_retry_count: number;
      reference_next_retry_at: Date | null;
    }>;

    expect(rows[0].status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect(Number(rows[0].reference_retry_count)).toBe(1);
    expect(rows[0].reference_next_retry_at).not.toBeNull();
    expect(await getBalance(walletId)).toBe('20.00');
  });
});
