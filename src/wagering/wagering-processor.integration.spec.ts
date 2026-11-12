
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../database/mikro-orm.config';
import { WageringProcessorService } from './wagering-processor.service';
import { WagerTransactionStatus } from './wager-transaction.entity';

describe('WageringProcessorService - PostgreSQL integration', () => {
  let orm: MikroORM;
  let processor: WageringProcessorService;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    processor = new WageringProcessorService(orm.em);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function createWallet(balance: string): Promise<string> {
    const walletId = randomUUID();

    await orm.em.execute(
      `
        INSERT INTO wallets (id, player_id, currency, balance)
        VALUES (?, ?, 'BRL', ?::numeric)
      `,
      [walletId, randomUUID(), balance],
    );

    return walletId;
  }

  async function getWalletBalance(walletId: string): Promise<string> {
    const rows = (await orm.em.execute(
      `SELECT balance FROM wallets WHERE id = ?`,
      [walletId],
    )) as Array<{ balance: string }>;

    return rows[0].balance;
  }

  async function getLedgerCount(walletId: string): Promise<number> {
    const rows = (await orm.em.execute(
      `
        SELECT COUNT(*)::int AS total
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
      `,
      [walletId],
    )) as Array<{ total: number }>;

    return rows[0].total;
  }

  async function getTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<string> {
    const rows = (await orm.em.execute(
      `
        SELECT id
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, externalTransactionId],
    )) as Array<{ id: string }>;

    return rows[0].id;
  }

  it('must process only one of two simultaneous bets of 80 BRL', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;

    const firstBet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '80.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const secondBet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId: firstBet.roundId,
      amount: '80.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const results = await Promise.all([
      processor.processBet(firstBet),
      processor.processBet(secondBet),
    ]);

    expect(
      results.filter(
        (result) =>
          result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);

    const rejected = results.filter(
      (result) =>
        result.status === WagerTransactionStatus.REJECTED,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe('INSUFFICIENT_FUNDS');

    const originalBet =
      results[0].status === WagerTransactionStatus.PROCESSED
        ? firstBet
        : secondBet;

    const duplicate = await processor.processBet(originalBet);

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.status).toBe(WagerTransactionStatus.PROCESSED);

    expect(await getWalletBalance(walletId)).toBe('20.00');
    expect(await getLedgerCount(walletId)).toBe(1);
  });

  it('must process only once when receiving 50 simultaneous duplicates', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;

    const bet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '10.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processor.processBet(bet)),
    );

    expect(results).toHaveLength(50);

    expect(
      results.filter(
        (result) =>
          result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(50);

    expect(results.filter((result) => result.duplicate)).toHaveLength(49);

    const transactions = (await orm.em.execute(
      `
        SELECT COUNT(*)::int AS total
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, bet.externalTransactionId],
    )) as Array<{ total: number }>;

    expect(transactions[0].total).toBe(1);
    expect(await getWalletBalance(walletId)).toBe('90.00');
    expect(await getLedgerCount(walletId)).toBe(1);
  }, 30000);

  it('must reject reuse of an idempotency key with a different transaction ID', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const idempotencyKey = `key-${randomUUID()}`;

    await processor.processBet({
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '10.00',
      idempotencyKey,
    });

    await expect(
      processor.processBet({
        walletId,
        providerId,
        externalTransactionId: `different-bet-${randomUUID()}`,
        roundId: `round-${randomUUID()}`,
        amount: '10.00',
        idempotencyKey,
      }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');

    expect(await getWalletBalance(walletId)).toBe('90.00');
  });

  it('must reject reuse of an external transaction ID with a different amount', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const externalTransactionId = `bet-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    await processor.processBet({
      walletId,
      providerId,
      externalTransactionId,
      roundId,
      amount: '10.00',
      idempotencyKey: `key-${randomUUID()}`,
    });

    await expect(
      processor.processBet({
        walletId,
        providerId,
        externalTransactionId,
        roundId,
        amount: '20.00',
        idempotencyKey: `another-key-${randomUUID()}`,
      }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');

    expect(await getWalletBalance(walletId)).toBe('90.00');
  });

  it('must credit the wallet and create a ledger entry when processing WIN', async () => {
    const walletId = await createWallet('100.00');

    const win = {
      walletId,
      providerId: `integration-${randomUUID()}`,
      externalTransactionId: `win-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processWin(win);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.duplicate).toBeFalsy();

    expect(await getWalletBalance(walletId)).toBe('150.00');
    expect(await getLedgerCount(walletId)).toBe(1);

    const ledger = (await orm.em.execute(
      `
        SELECT type, amount, balance_after
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
      `,
      [walletId],
    )) as Array<{
      type: string;
      amount: string;
      balance_after: string;
    }>;

    expect(ledger[0].type).toBe('WIN');
    expect(ledger[0].amount).toBe('50.00');
    expect(ledger[0].balance_after).toBe('150.00');
  });

  it('must not change the wallet balance or create a ledger entry when processing LOSS', async () => {
    const walletId = await createWallet('100.00');

    const loss = {
      walletId,
      providerId: `integration-${randomUUID()}`,
      externalTransactionId: `loss-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processLoss(loss);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.duplicate).toBeFalsy();

    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(0);
  });

  it('must not credit the wallet twice when receiving duplicate WIN', async () => {
    const walletId = await createWallet('100.00');

    const win = {
      walletId,
      providerId: `integration-${randomUUID()}`,
      externalTransactionId: `win-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const firstResult = await processor.processWin(win);
    const duplicateResult = await processor.processWin(win);

    expect(firstResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.duplicate).toBe(true);

    expect(await getWalletBalance(walletId)).toBe('150.00');
    expect(await getLedgerCount(walletId)).toBe(1);
  });

  it('must not process duplicate LOSS more than once', async () => {
    const walletId = await createWallet('100.00');

    const loss = {
      walletId,
      providerId: `integration-${randomUUID()}`,
      externalTransactionId: `loss-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const firstResult = await processor.processLoss(loss);
    const duplicateResult = await processor.processLoss(loss);

    expect(firstResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.duplicate).toBe(true);

    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(0);
  });

  it('must refund a processed BET and credit the wallet', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const bet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId,
      amount: '30.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const betResult = await processor.processBet(bet);

    expect(betResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await getWalletBalance(walletId)).toBe('70.00');

    const referenceTransactionId = await getTransactionId(
      providerId,
      bet.externalTransactionId,
    );

    const refund = {
      walletId,
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      roundId,
      amount: '30.00',
      referenceTransactionId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRefund(refund);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.duplicate).toBeFalsy();
    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(2);

    const ledger = (await orm.em.execute(
      `
        SELECT type, amount, balance_after
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
        ORDER BY created_at ASC
      `,
      [walletId],
    )) as Array<{
      type: string;
      amount: string;
      balance_after: string;
    }>;

    expect(ledger[1].type).toBe('REFUND');
    expect(ledger[1].amount).toBe('30.00');
    expect(ledger[1].balance_after).toBe('100.00');
  });

  it('must not credit the wallet twice when receiving duplicate REFUND', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const bet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId,
      amount: '25.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    await processor.processBet(bet);

    const referenceTransactionId = await getTransactionId(
      providerId,
      bet.externalTransactionId,
    );

    const refund = {
      walletId,
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      roundId,
      amount: '25.00',
      referenceTransactionId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const firstResult = await processor.processRefund(refund);
    const duplicateResult = await processor.processRefund(refund);

    expect(firstResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(duplicateResult.duplicate).toBe(true);

    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(2);
  });

  it('must rollback a processed BET and credit the wallet', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const bet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId,
      amount: '40.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    await processor.processBet(bet);

    const referenceTransactionId = await getTransactionId(
      providerId,
      bet.externalTransactionId,
    );

    const rollback = {
      walletId,
      providerId,
      externalTransactionId: `rollback-${randomUUID()}`,
      roundId,
      amount: '40.00',
      referenceTransactionId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRollback(rollback);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.duplicate).toBeFalsy();
    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(2);

    const ledger = (await orm.em.execute(
      `
        SELECT type, amount, balance_after
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
        ORDER BY created_at ASC
      `,
      [walletId],
    )) as Array<{
      type: string;
      amount: string;
      balance_after: string;
    }>;

    expect(ledger[1].type).toBe('ROLLBACK');
    expect(ledger[1].amount).toBe('40.00');
    expect(ledger[1].balance_after).toBe('100.00');
  });

  it('must debit the wallet when rolling back a processed WIN', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const win = {
      walletId,
      providerId,
      externalTransactionId: `win-${randomUUID()}`,
      roundId,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    await processor.processWin(win);

    const referenceTransactionId = await getTransactionId(
      providerId,
      win.externalTransactionId,
    );

    const rollback = {
      walletId,
      providerId,
      externalTransactionId: `rollback-${randomUUID()}`,
      roundId,
      amount: '50.00',
      referenceTransactionId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRollback(rollback);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(2);

    const ledger = (await orm.em.execute(
      `
        SELECT type, amount, balance_after
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
        ORDER BY created_at ASC
      `,
      [walletId],
    )) as Array<{
      type: string;
      amount: string;
      balance_after: string;
    }>;

    expect(ledger[1].type).toBe('ROLLBACK');
    expect(ledger[1].amount).toBe('-50.00');
    expect(ledger[1].balance_after).toBe('100.00');
  });

  it('must reject rollback of WIN when it would make the wallet balance negative', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const win = {
      walletId,
      providerId,
      externalTransactionId: `win-${randomUUID()}`,
      roundId,
      amount: '50.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const winResult = await processor.processWin(win);

    expect(winResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await getWalletBalance(walletId)).toBe('150.00');

    const bet = {
      walletId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      roundId: `another-round-${randomUUID()}`,
      amount: '140.00',
      idempotencyKey: `key-${randomUUID()}`,
    };

    const betResult = await processor.processBet(bet);

    expect(betResult.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await getWalletBalance(walletId)).toBe('10.00');

    const referenceTransactionId = await getTransactionId(
      providerId,
      win.externalTransactionId,
    );

    const rollback = {
      walletId,
      providerId,
      externalTransactionId: `rollback-${randomUUID()}`,
      roundId,
      amount: '50.00',
      referenceTransactionId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRollback(rollback);

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');

    expect(await getWalletBalance(walletId)).toBe('10.00');
    expect(await getLedgerCount(walletId)).toBe(2);

    const rollbackTransactions = (await orm.em.execute(
      `
        SELECT status, failure_code
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, rollback.externalTransactionId],
    )) as Array<{
      status: string;
      failure_code: string | null;
    }>;

    expect(rollbackTransactions).toHaveLength(1);
    expect(rollbackTransactions[0].status).toBe('REJECTED');
    expect(rollbackTransactions[0].failure_code).toBe(
      'REVERSAL_INSUFFICIENT_FUNDS',
    );
  });

  it('must register REFUND as pending when its reference transaction does not exist', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const missingReferenceId = randomUUID();

    const refund = {
      walletId,
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      roundId,
      amount: '30.00',
      referenceTransactionId: missingReferenceId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRefund(refund);

    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(result.duplicate).toBeFalsy();

    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(0);

    const transaction = (await orm.em.execute(
      `
        SELECT
          status,
          reference_transaction_id,
          pending_reference_transaction_id,
          reference_retry_count,
          reference_next_retry_at
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, refund.externalTransactionId],
    )) as Array<{
      status: string;
      reference_transaction_id: string | null;
      pending_reference_transaction_id: string | null;
      reference_retry_count: number;
      reference_next_retry_at: Date | null;
    }>;

    expect(transaction).toHaveLength(1);
    expect(transaction[0].status).toBe('PENDING_REFERENCE');
    expect(transaction[0].reference_transaction_id).toBeNull();
    expect(transaction[0].pending_reference_transaction_id).toBe(
      missingReferenceId,
    );
    expect(transaction[0].reference_retry_count).toBe(0);
    expect(transaction[0].reference_next_retry_at).not.toBeNull();
  });

  it('must register ROLLBACK as pending when its reference transaction does not exist', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const missingReferenceId = randomUUID();

    const rollback = {
      walletId,
      providerId,
      externalTransactionId: `rollback-${randomUUID()}`,
      roundId,
      amount: '30.00',
      referenceTransactionId: missingReferenceId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const result = await processor.processRollback(rollback);

    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(result.duplicate).toBeFalsy();

    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(0);

    const transaction = (await orm.em.execute(
      `
        SELECT
          status,
          reference_transaction_id,
          pending_reference_transaction_id,
          reference_retry_count,
          reference_next_retry_at
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, rollback.externalTransactionId],
    )) as Array<{
      status: string;
      reference_transaction_id: string | null;
      pending_reference_transaction_id: string | null;
      reference_retry_count: number;
      reference_next_retry_at: Date | null;
    }>;

    expect(transaction).toHaveLength(1);
    expect(transaction[0].status).toBe('PENDING_REFERENCE');
    expect(transaction[0].reference_transaction_id).toBeNull();
    expect(transaction[0].pending_reference_transaction_id).toBe(
      missingReferenceId,
    );
    expect(transaction[0].reference_retry_count).toBe(0);
    expect(transaction[0].reference_next_retry_at).not.toBeNull();
  });

  it('must not create another pending transaction when receiving duplicate REFUND', async () => {
    const walletId = await createWallet('100.00');
    const providerId = `integration-${randomUUID()}`;
    const missingReferenceId = randomUUID();

    const refund = {
      walletId,
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      roundId: `round-${randomUUID()}`,
      amount: '25.00',
      referenceTransactionId: missingReferenceId,
      idempotencyKey: `key-${randomUUID()}`,
    };

    const firstResult = await processor.processRefund(refund);
    const duplicateResult = await processor.processRefund(refund);

    expect(firstResult.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(duplicateResult.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(firstResult.duplicate).toBeFalsy();
    expect(duplicateResult.duplicate).toBe(true);
    expect(duplicateResult.transactionId).toBe(firstResult.transactionId);

    const transactions = (await orm.em.execute(
      `
        SELECT COUNT(*)::int AS total
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
      `,
      [providerId, refund.externalTransactionId],
    )) as Array<{ total: number }>;

    expect(transactions[0].total).toBe(1);
    expect(await getWalletBalance(walletId)).toBe('100.00');
    expect(await getLedgerCount(walletId)).toBe(0);
  });
});
