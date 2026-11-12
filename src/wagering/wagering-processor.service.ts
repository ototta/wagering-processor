import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';

import { Money } from './money';
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from './wager-transaction.entity';
import { WageringRules } from './wagering-rules';

export interface ProcessBetInput {
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  amount: string;
  idempotencyKey?: string;
}

export interface ProcessReversalInput extends ProcessBetInput {
  referenceTransactionId: string;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  currency: string;
  failureCode: string | null;
  duplicate: boolean;
}

interface ExistingTransaction {
  id: string;
  status: WagerTransactionStatus;
  type: WagerTransactionType;
  amount: string;
  currency: string;
  wallet_id: string;
  round_id: string;
  effective_reference_transaction_id: string | null;
  failure_code: string | null;
  matches_external_id: boolean;
}

interface OriginalTransaction {
  id: string;
  wallet_id: string;
  provider_id: string;
  round_id: string;
  type: WagerTransactionType;
  status: WagerTransactionStatus;
  amount: string;
  currency: string;
}

interface WalletRow {
  id: string;
  balance: string;
  currency: string;
}

interface PendingReferenceRow {
  id: string;
  wallet_id: string;
  provider_id: string;
  external_transaction_id: string;
  round_id: string;
  type: WagerTransactionType.REFUND | WagerTransactionType.ROLLBACK;
  amount: string;
  currency: string;
  pending_reference_transaction_id: string;
  reference_retry_count: number;
}

@Injectable()
export class WageringProcessorService {
  private readonly maxReferenceAttempts = 5;
  private readonly pendingBatchSize = 20;

  constructor(private readonly em: EntityManager) {}

  async processBet(
    input: ProcessBetInput,
  ): Promise<ProcessBetResult> {
    const em = this.em.fork({ clear: true });

    return em.transactional(
      async (tx) => {
        // Lock the wallet before inserting the transaction. The INSERT
        // references wallets through a foreign key; inserting first can
        // acquire a KEY SHARE lock and deadlock with another instance
        // trying to acquire FOR UPDATE on the same wallet.
        const wallets = (await tx.execute(
          `
            SELECT id, balance, currency
            FROM wallets
            WHERE id = ?
            FOR UPDATE
          `,
          [input.walletId],
        )) as WalletRow[];

        if (wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];
        const transactionId = randomUUID();

        const inserted = (await tx.execute(
          `
            INSERT INTO wager_transactions (
              id, wallet_id, provider_id,
              external_transaction_id, round_id,
              type, status, amount, currency,
              idempotency_key, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, NOW())
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [
            transactionId,
            input.walletId,
            input.providerId,
            input.externalTransactionId,
            input.roundId,
            WagerTransactionType.BET,
            WagerTransactionStatus.PENDING,
            input.amount,
            wallet.currency,
            input.idempotencyKey ?? null,
          ],
        )) as Array<{ id: string }>;

        if (inserted.length === 0) {
          return this.resolveDuplicate(
            tx,
            input,
            WagerTransactionType.BET,
          );
        }

        const currentBalance = Money.create(
          wallet.balance,
          wallet.currency,
        );

        const betAmount = Money.create(
          input.amount,
          wallet.currency,
        );

        try {
          WageringRules.calculateBalance(
            currentBalance,
            betAmount,
            WagerTransactionType.BET,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'INSUFFICIENT_FUNDS'
          ) {
            return this.rejectBet(
              tx,
              transactionId,
              input,
              currentBalance.toString(),
              wallet.currency,
            );
          }

          throw error;
        }

        const updated = (await tx.execute(
          `
            UPDATE wallets
            SET balance = balance - ?::numeric,
                updated_at = NOW()
            WHERE id = ?
              AND balance >= ?::numeric
            RETURNING balance
          `,
          [
            betAmount.toString(),
            input.walletId,
            betAmount.toString(),
          ],
        )) as Array<{ balance: string }>;

        if (updated.length === 0) {
          const latest = (await tx.execute(
            `
              SELECT balance
              FROM wallets
              WHERE id = ?
            `,
            [input.walletId],
          )) as Array<{ balance: string }>;

          const latestBalance = Money.create(
            latest[0].balance,
            wallet.currency,
          );

          return this.rejectBet(
            tx,
            transactionId,
            input,
            latestBalance.toString(),
            wallet.currency,
          );
        }

        const actualBalance = Money.create(
          updated[0].balance,
          wallet.currency,
        );

        await tx.execute(
          `
            INSERT INTO wallet_ledger_entries (
              id, wallet_id, wager_transaction_id,
              type, amount, balance_after, currency, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          `,
          [
            randomUUID(),
            input.walletId,
            transactionId,
            'BET',
            `-${betAmount.toString()}`,
            actualBalance.toString(),
            wallet.currency,
          ],
        );

        await tx.execute(
          `
            UPDATE wager_transactions
            SET status = ?, processed_at = NOW()
            WHERE id = ?
          `,
          [
            WagerTransactionStatus.PROCESSED,
            transactionId,
          ],
        );

        await this.createOutboxEvent(
          tx,
          transactionId,
          'WagerTransactionProcessed',
          {
            transactionId,
            walletId: input.walletId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            amount: betAmount.toString(),
            currency: wallet.currency,
            balance: actualBalance.toString(),
          },
        );

        return {
          transactionId,
          status: WagerTransactionStatus.PROCESSED,
          balance: actualBalance.toString(),
          currency: wallet.currency,
          failureCode: null,
          duplicate: false,
        };
      },
      { clear: true },
    );
  }

  async processWin(
    input: ProcessBetInput,
  ): Promise<ProcessBetResult> {
    return this.processWinOrLoss(input, WagerTransactionType.WIN);
  }

  async processLoss(
    input: ProcessBetInput,
  ): Promise<ProcessBetResult> {
    return this.processWinOrLoss(input, WagerTransactionType.LOSS);
  }

  async processRefund(
    input: ProcessReversalInput,
  ): Promise<ProcessBetResult> {
    return this.processReversal(input, WagerTransactionType.REFUND);
  }

  async processRollback(
    input: ProcessReversalInput,
  ): Promise<ProcessBetResult> {
    return this.processReversal(input, WagerTransactionType.ROLLBACK);
  }

  async processPendingReferences(): Promise<number> {
    const em = this.em.fork({ clear: true });

    return em.transactional(
      async (tx) => {
        const pending = (await tx.execute(
          `
            SELECT
              id,
              wallet_id,
              provider_id,
              external_transaction_id,
              round_id,
              type,
              amount,
              currency,
              pending_reference_transaction_id,
              reference_retry_count
            FROM wager_transactions
            WHERE status = ?
              AND pending_reference_transaction_id IS NOT NULL
              AND reference_next_retry_at <= NOW()
            ORDER BY reference_next_retry_at, created_at
            LIMIT ?
            FOR UPDATE SKIP LOCKED
          `,
          [
            WagerTransactionStatus.PENDING_REFERENCE,
            this.pendingBatchSize,
          ],
        )) as PendingReferenceRow[];

        let processed = 0;

        for (const transaction of pending) {
          await this.processSinglePendingReference(tx, transaction);
          processed++;
        }

        return processed;
      },
      { clear: true },
    );
  }

  private async processSinglePendingReference(
    tx: EntityManager,
    pending: PendingReferenceRow,
  ): Promise<void> {
    const originals = (await tx.execute(
      `
        SELECT
          id,
          wallet_id,
          provider_id,
          round_id,
          type,
          status,
          amount,
          currency
        FROM wager_transactions
        WHERE id = ?
        FOR UPDATE
      `,
      [pending.pending_reference_transaction_id],
    )) as OriginalTransaction[];

    if (originals.length === 0) {
      await this.retryPendingReference(tx, pending);
      return;
    }

    const original = originals[0];

    const failureCode = this.validatePendingReference(
      pending,
      original,
    );

    if (failureCode) {
      await this.rejectPendingReference(
        tx,
        pending,
        failureCode,
        original.id,
      );
      return;
    }

    const previousReversals = (await tx.execute(
      `
        SELECT id
        FROM wager_transactions
        WHERE reference_transaction_id = ?
          AND status = ?
          AND (
            type = ?
            OR (
              ? = ?
              AND type = ?
            )
          )
        LIMIT 1
      `,
      [
        original.id,
        WagerTransactionStatus.PROCESSED,
        WagerTransactionType.ROLLBACK,
        original.type,
        WagerTransactionType.BET,
        WagerTransactionType.REFUND,
      ],
    )) as Array<{ id: string }>;

    if (previousReversals.length > 0) {
      await this.rejectPendingReference(
        tx,
        pending,
        'TRANSACTION_ALREADY_REVERSED',
        original.id,
      );
      return;
    }

    const wallets = (await tx.execute(
      `
        SELECT id, balance, currency
        FROM wallets
        WHERE id = ?
        FOR UPDATE
      `,
      [pending.wallet_id],
    )) as WalletRow[];

    if (wallets.length === 0) {
      await this.rejectPendingReference(
        tx,
        pending,
        'WALLET_NOT_FOUND',
        original.id,
      );
      return;
    }

    const wallet = wallets[0];

    if (wallet.currency !== original.currency) {
      await this.rejectPendingReference(
        tx,
        pending,
        'REFERENCE_TRANSACTION_MISMATCH',
        original.id,
      );
      return;
    }

    const currentBalance = Money.create(
      wallet.balance,
      wallet.currency,
    );

    const amount = Money.create(
      pending.amount,
      wallet.currency,
    );

    const shouldCredit =
      pending.type === WagerTransactionType.REFUND ||
      (
        pending.type === WagerTransactionType.ROLLBACK &&
        original.type === WagerTransactionType.BET
      );

    const calculatedBalance = shouldCredit
      ? currentBalance.add(amount)
      : currentBalance.subtract(amount);

    if (calculatedBalance.isNegative()) {
      await this.rejectPendingReference(
        tx,
        pending,
        'REVERSAL_INSUFFICIENT_FUNDS',
        original.id,
        currentBalance.toString(),
      );
      return;
    }

    await tx.execute(
      `
        UPDATE wager_transactions
        SET reference_transaction_id = ?,
            pending_reference_transaction_id = NULL,
            reference_next_retry_at = NULL,
            reference_last_attempt_at = NOW()
        WHERE id = ?
      `,
      [original.id, pending.id],
    );

    const updated = (await tx.execute(
      `
        UPDATE wallets
        SET balance = ?::numeric,
            updated_at = NOW()
        WHERE id = ?
        RETURNING balance
      `,
      [calculatedBalance.toString(), pending.wallet_id],
    )) as Array<{ balance: string }>;

    const actualBalance = Money.create(
      updated[0].balance,
      wallet.currency,
    );

    const ledgerAmount = shouldCredit
      ? amount.toString()
      : `-${amount.toString()}`;

    await tx.execute(
      `
        INSERT INTO wallet_ledger_entries (
          id,
          wallet_id,
          wager_transaction_id,
          type,
          amount,
          balance_after,
          currency,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        randomUUID(),
        pending.wallet_id,
        pending.id,
        pending.type,
        ledgerAmount,
        actualBalance.toString(),
        wallet.currency,
      ],
    );

    await tx.execute(
      `
        UPDATE wager_transactions
        SET status = ?,
            processed_at = NOW(),
            failure_code = NULL
        WHERE id = ?
      `,
      [
        WagerTransactionStatus.PROCESSED,
        pending.id,
      ],
    );

    await this.createOutboxEvent(
      tx,
      pending.id,
      'WagerTransactionProcessed',
      {
        transactionId: pending.id,
        walletId: pending.wallet_id,
        providerId: pending.provider_id,
        externalTransactionId: pending.external_transaction_id,
        referenceTransactionId: original.id,
        type: pending.type,
        amount: amount.toString(),
        currency: wallet.currency,
        balance: actualBalance.toString(),
      },
    );

    await this.createOutboxEvent(
      tx,
      pending.id,
      'WalletBalanceChanged',
      {
        transactionId: pending.id,
        walletId: pending.wallet_id,
        balance: actualBalance.toString(),
        currency: wallet.currency,
      },
    );
  }

  private validatePendingReference(
    pending: PendingReferenceRow,
    original: OriginalTransaction,
  ): string | null {
    if (original.status !== WagerTransactionStatus.PROCESSED) {
      return 'REFERENCE_TRANSACTION_NOT_PROCESSED';
    }

    if (
      pending.type === WagerTransactionType.REFUND &&
      original.type !== WagerTransactionType.BET
    ) {
      return 'INVALID_REFUND_REFERENCE';
    }

    if (
      pending.type === WagerTransactionType.ROLLBACK &&
      ![
        WagerTransactionType.BET,
        WagerTransactionType.WIN,
        WagerTransactionType.REFUND,
      ].includes(original.type)
    ) {
      return 'INVALID_ROLLBACK_REFERENCE';
    }

    if (
      original.provider_id !== pending.provider_id ||
      original.wallet_id !== pending.wallet_id ||
      original.round_id !== pending.round_id ||
      original.currency !== pending.currency
    ) {
      return 'REFERENCE_TRANSACTION_MISMATCH';
    }

    const originalAmount = Money.create(
      original.amount,
      original.currency,
    );

    const pendingAmount = Money.create(
      pending.amount,
      pending.currency,
    );

    if (!originalAmount.isEqualTo(pendingAmount)) {
      return 'REFERENCE_TRANSACTION_MISMATCH';
    }

    return null;
  }

  private async retryPendingReference(
    tx: EntityManager,
    pending: PendingReferenceRow,
  ): Promise<void> {
    const nextAttempt = pending.reference_retry_count + 1;

    if (nextAttempt >= this.maxReferenceAttempts) {
      await tx.execute(
        `
          UPDATE wager_transactions
          SET status = ?,
              failure_code = ?,
              reference_retry_count = ?,
              reference_last_attempt_at = NOW(),
              reference_next_retry_at = NULL
          WHERE id = ?
        `,
        [
          WagerTransactionStatus.REJECTED,
          'REFERENCE_TRANSACTION_NOT_FOUND',
          nextAttempt,
          pending.id,
        ],
      );

      await this.createOutboxEvent(
        tx,
        pending.id,
        'WagerTransactionRejected',
        {
          transactionId: pending.id,
          walletId: pending.wallet_id,
          providerId: pending.provider_id,
          externalTransactionId: pending.external_transaction_id,
          referenceTransactionId:
            pending.pending_reference_transaction_id,
          failureCode: 'REFERENCE_TRANSACTION_NOT_FOUND',
          retryCount: nextAttempt,
        },
      );

      return;
    }

    const delaySeconds = Math.min(
      5 * Math.pow(2, nextAttempt),
      60,
    );

    await tx.execute(
      `
        UPDATE wager_transactions
        SET reference_retry_count = ?,
            reference_last_attempt_at = NOW(),
            reference_next_retry_at =
              NOW() + (? * INTERVAL '1 second')
        WHERE id = ?
      `,
      [
        nextAttempt,
        delaySeconds,
        pending.id,
      ],
    );
  }

  private async rejectPendingReference(
    tx: EntityManager,
    pending: PendingReferenceRow,
    failureCode: string,
    originalId: string,
    balance?: string,
  ): Promise<void> {
    await tx.execute(
      `
        UPDATE wager_transactions
        SET status = ?,
            reference_transaction_id = ?,
            pending_reference_transaction_id = NULL,
            reference_next_retry_at = NULL,
            reference_last_attempt_at = NOW(),
            failure_code = ?
        WHERE id = ?
      `,
      [
        WagerTransactionStatus.REJECTED,
        originalId,
        failureCode,
        pending.id,
      ],
    );

    await this.createOutboxEvent(
      tx,
      pending.id,
      'WagerTransactionRejected',
      {
        transactionId: pending.id,
        walletId: pending.wallet_id,
        providerId: pending.provider_id,
        externalTransactionId: pending.external_transaction_id,
        referenceTransactionId: originalId,
        failureCode,
        ...(balance ? { balance } : {}),
      },
    );
  }

  private async processWinOrLoss(
    input: ProcessBetInput,
    type: WagerTransactionType.WIN | WagerTransactionType.LOSS,
  ): Promise<ProcessBetResult> {
    const em = this.em.fork({ clear: true });

    return em.transactional(
      async (tx) => {
        // Keep the same lock order used by BET processing:
        // wallet lock first, then transaction insertion.
        const wallets = (await tx.execute(
          `
            SELECT id, balance, currency
            FROM wallets
            WHERE id = ?
            FOR UPDATE
          `,
          [input.walletId],
        )) as WalletRow[];

        if (wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];
        const transactionId = randomUUID();

        const inserted = (await tx.execute(
          `
            INSERT INTO wager_transactions (
              id, wallet_id, provider_id,
              external_transaction_id, round_id,
              type, status, amount, currency,
              idempotency_key, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, NOW())
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [
            transactionId,
            input.walletId,
            input.providerId,
            input.externalTransactionId,
            input.roundId,
            type,
            WagerTransactionStatus.PENDING,
            input.amount,
            wallet.currency,
            input.idempotencyKey ?? null,
          ],
        )) as Array<{ id: string }>;

        if (inserted.length === 0) {
          return this.resolveDuplicate(tx, input, type);
        }

        const currentBalance = Money.create(
          wallet.balance,
          wallet.currency,
        );

        const amount = Money.create(input.amount, wallet.currency);

        const calculatedBalance = WageringRules.calculateBalance(
          currentBalance,
          amount,
          type,
        );

        let actualBalance = currentBalance;

        if (type === WagerTransactionType.WIN) {
          const updated = (await tx.execute(
            `
              UPDATE wallets
              SET balance = balance + ?::numeric,
                  updated_at = NOW()
              WHERE id = ?
              RETURNING balance
            `,
            [amount.toString(), input.walletId],
          )) as Array<{ balance: string }>;

          actualBalance = Money.create(
            updated[0].balance,
            wallet.currency,
          );

          await tx.execute(
            `
              INSERT INTO wallet_ledger_entries (
                id, wallet_id, wager_transaction_id,
                type, amount, balance_after, currency, created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `,
            [
              randomUUID(),
              input.walletId,
              transactionId,
              'WIN',
              amount.toString(),
              actualBalance.toString(),
              wallet.currency,
            ],
          );
        }

        if (
          type === WagerTransactionType.LOSS &&
          !calculatedBalance.isEqualTo(currentBalance)
        ) {
          throw new Error('INVALID_LOSS_BALANCE');
        }

        await tx.execute(
          `
            UPDATE wager_transactions
            SET status = ?, processed_at = NOW()
            WHERE id = ?
          `,
          [
            WagerTransactionStatus.PROCESSED,
            transactionId,
          ],
        );

        await this.createOutboxEvent(
          tx,
          transactionId,
          'WagerTransactionProcessed',
          {
            transactionId,
            walletId: input.walletId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            type,
            amount: amount.toString(),
            currency: wallet.currency,
            balance: actualBalance.toString(),
          },
        );

        return {
          transactionId,
          status: WagerTransactionStatus.PROCESSED,
          balance: actualBalance.toString(),
          currency: wallet.currency,
          failureCode: null,
          duplicate: false,
        };
      },
      { clear: true },
    );
  }

  private async processReversal(
    input: ProcessReversalInput,
    type: WagerTransactionType.REFUND | WagerTransactionType.ROLLBACK,
  ): Promise<ProcessBetResult> {
    const em = this.em.fork({ clear: true });

    return em.transactional(
      async (tx) => {
        const originals = (await tx.execute(
          `
            SELECT
              id,
              wallet_id,
              provider_id,
              round_id,
              type,
              status,
              amount,
              currency
            FROM wager_transactions
            WHERE id = ?
            FOR UPDATE
          `,
          [input.referenceTransactionId],
        )) as OriginalTransaction[];

        if (originals.length === 0) {
          return this.registerPendingReference(tx, input, type);
        }

        const original = originals[0];

        if (original.status !== WagerTransactionStatus.PROCESSED) {
          throw new Error('REFERENCE_TRANSACTION_NOT_PROCESSED');
        }

        if (
          type === WagerTransactionType.REFUND &&
          original.type !== WagerTransactionType.BET
        ) {
          throw new Error('INVALID_REFUND_REFERENCE');
        }

        if (
          type === WagerTransactionType.ROLLBACK &&
          ![
            WagerTransactionType.BET,
            WagerTransactionType.WIN,
            WagerTransactionType.REFUND,
          ].includes(original.type)
        ) {
          throw new Error('INVALID_ROLLBACK_REFERENCE');
        }

        const sameProvider = original.provider_id === input.providerId;
        const sameWallet = original.wallet_id === input.walletId;
        const sameRound = original.round_id === input.roundId;

        const sameAmount = Money.create(
          original.amount,
          original.currency,
        ).isEqualTo(
          Money.create(input.amount, original.currency),
        );

        if (
          !sameProvider ||
          !sameWallet ||
          !sameRound ||
          !sameAmount
        ) {
          throw new Error('REFERENCE_TRANSACTION_MISMATCH');
        }

        const transactionId = randomUUID();

        const inserted = (await tx.execute(
          `
            INSERT INTO wager_transactions (
              id, wallet_id, provider_id,
              external_transaction_id, round_id,
              type, status, amount, currency,
              reference_transaction_id,
              idempotency_key, created_at
            )
            SELECT
              ?, w.id, ?, ?, ?, ?, ?, ?::numeric,
              w.currency, ?, ?, NOW()
            FROM wallets w
            WHERE w.id = ?
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [
            transactionId,
            input.providerId,
            input.externalTransactionId,
            input.roundId,
            type,
            WagerTransactionStatus.PENDING,
            input.amount,
            input.referenceTransactionId,
            input.idempotencyKey ?? null,
            input.walletId,
          ],
        )) as Array<{ id: string }>;

        if (inserted.length === 0) {
          return this.resolveDuplicate(
            tx,
            input,
            type,
            input.referenceTransactionId,
          );
        }

        const previousReversals = (await tx.execute(
          `
            SELECT id, type
            FROM wager_transactions
            WHERE reference_transaction_id = ?
              AND status = ?
              AND (
                type = ?
                OR (
                  ? = ?
                  AND type = ?
                )
              )
          `,
          [
            original.id,
            WagerTransactionStatus.PROCESSED,
            WagerTransactionType.ROLLBACK,
            original.type,
            WagerTransactionType.BET,
            WagerTransactionType.REFUND,
          ],
        )) as Array<{ id: string; type: WagerTransactionType }>;

        if (previousReversals.length > 0) {
          throw new Error('TRANSACTION_ALREADY_REVERSED');
        }

        const wallets = (await tx.execute(
          `
            SELECT id, balance, currency
            FROM wallets
            WHERE id = ?
            FOR UPDATE
          `,
          [input.walletId],
        )) as WalletRow[];

        if (wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];

        if (wallet.currency !== original.currency) {
          throw new Error('REFERENCE_TRANSACTION_MISMATCH');
        }

        const currentBalance = Money.create(
          wallet.balance,
          wallet.currency,
        );

        const amount = Money.create(input.amount, wallet.currency);

        if (!amount.isGreaterThan(Money.create('0.00', wallet.currency))) {
          throw new Error('INVALID_AMOUNT');
        }

        const shouldCredit =
          type === WagerTransactionType.REFUND ||
          (
            type === WagerTransactionType.ROLLBACK &&
            original.type === WagerTransactionType.BET
          );

        const calculatedBalance = shouldCredit
          ? currentBalance.add(amount)
          : currentBalance.subtract(amount);

        if (calculatedBalance.isNegative()) {
          return this.rejectReversal(
            tx,
            transactionId,
            input,
            currentBalance.toString(),
            wallet.currency,
          );
        }

        const updated = (await tx.execute(
          `
            UPDATE wallets
            SET balance = ?::numeric,
                updated_at = NOW()
            WHERE id = ?
            RETURNING balance
          `,
          [calculatedBalance.toString(), input.walletId],
        )) as Array<{ balance: string }>;

        const actualBalance = Money.create(
          updated[0].balance,
          wallet.currency,
        );

        const ledgerAmount = shouldCredit
          ? amount.toString()
          : `-${amount.toString()}`;

        await tx.execute(
          `
            INSERT INTO wallet_ledger_entries (
              id, wallet_id, wager_transaction_id,
              type, amount, balance_after, currency, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          `,
          [
            randomUUID(),
            input.walletId,
            transactionId,
            type,
            ledgerAmount,
            actualBalance.toString(),
            wallet.currency,
          ],
        );

        await tx.execute(
          `
            UPDATE wager_transactions
            SET status = ?, processed_at = NOW()
            WHERE id = ?
          `,
          [
            WagerTransactionStatus.PROCESSED,
            transactionId,
          ],
        );

        await this.createOutboxEvent(
          tx,
          transactionId,
          'WagerTransactionProcessed',
          {
            transactionId,
            walletId: input.walletId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            referenceTransactionId: original.id,
            type,
            amount: amount.toString(),
            currency: wallet.currency,
            balance: actualBalance.toString(),
          },
        );

        return {
          transactionId,
          status: WagerTransactionStatus.PROCESSED,
          balance: actualBalance.toString(),
          currency: wallet.currency,
          failureCode: null,
          duplicate: false,
        };
      },
      { clear: true },
    );
  }

  private async registerPendingReference(
    em: EntityManager,
    input: ProcessReversalInput,
    type: WagerTransactionType.REFUND | WagerTransactionType.ROLLBACK,
  ): Promise<ProcessBetResult> {
    const wallets = (await em.execute(
      `
        SELECT id, balance, currency
        FROM wallets
        WHERE id = ?
      `,
      [input.walletId],
    )) as WalletRow[];

    if (wallets.length === 0) {
      throw new Error('WALLET_NOT_FOUND');
    }

    const wallet = wallets[0];

    const amount = Money.create(input.amount, wallet.currency);
    const zero = Money.create('0.00', wallet.currency);

    if (!amount.isGreaterThan(zero)) {
      throw new Error('INVALID_AMOUNT');
    }

    const transactionId = randomUUID();

    const inserted = (await em.execute(
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
          pending_reference_transaction_id,
          reference_retry_count,
          reference_next_retry_at,
          idempotency_key,
          created_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?,
          ?, 0, NOW() + INTERVAL '5 seconds', ?, NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        transactionId,
        input.walletId,
        input.providerId,
        input.externalTransactionId,
        input.roundId,
        type,
        WagerTransactionStatus.PENDING_REFERENCE,
        amount.toString(),
        wallet.currency,
        input.referenceTransactionId,
        input.idempotencyKey ?? null,
      ],
    )) as Array<{ id: string }>;

    if (inserted.length === 0) {
      return this.resolveDuplicate(
        em,
        input,
        type,
        input.referenceTransactionId,
      );
    }

    await this.createOutboxEvent(
      em,
      transactionId,
      'WagerTransactionPendingReference',
      {
        transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        referenceTransactionId: input.referenceTransactionId,
        type,
        amount: amount.toString(),
        currency: wallet.currency,
        retryCount: 0,
      },
    );

    return {
      transactionId,
      status: WagerTransactionStatus.PENDING_REFERENCE,
      balance: wallet.balance,
      currency: wallet.currency,
      failureCode: null,
      duplicate: false,
    };
  }

  private async resolveDuplicate(
    em: EntityManager,
    input: ProcessBetInput,
    expectedType: WagerTransactionType,
    expectedReferenceTransactionId?: string | null,
  ): Promise<ProcessBetResult> {
    const existing = (await em.execute(
      `
        SELECT
          id,
          status,
          type,
          amount,
          currency,
          wallet_id,
          round_id,
          COALESCE(
            reference_transaction_id,
            pending_reference_transaction_id
          ) AS effective_reference_transaction_id,
          failure_code,
          (external_transaction_id = ?) AS matches_external_id
        FROM wager_transactions
        WHERE provider_id = ?
          AND (
            external_transaction_id = ?
            OR (
              ?::varchar IS NOT NULL
              AND idempotency_key = ?
            )
          )
      `,
      [
        input.externalTransactionId,
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey ?? null,
        input.idempotencyKey ?? null,
      ],
    )) as ExistingTransaction[];

    if (existing.length === 0) {
      const wallets = (await em.execute(
        `SELECT id FROM wallets WHERE id = ?`,
        [input.walletId],
      )) as Array<{ id: string }>;

      if (wallets.length === 0) {
        throw new Error('WALLET_NOT_FOUND');
      }

      throw new Error('TRANSACTION_CONFLICT');
    }

    if (existing.length > 1) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const previous = existing[0];

    if (
      !previous.matches_external_id ||
      previous.type !== expectedType ||
      previous.effective_reference_transaction_id !==
        (expectedReferenceTransactionId ?? null)
    ) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const sameWallet = previous.wallet_id === input.walletId;
    const sameRound = previous.round_id === input.roundId;

    const sameAmount = Money.create(
      previous.amount,
      previous.currency,
    ).isEqualTo(
      Money.create(input.amount, previous.currency),
    );

    if (!sameWallet || !sameRound || !sameAmount) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const currentWallet = (await em.execute(
      `
        SELECT balance
        FROM wallets
        WHERE id = ?
      `,
      [previous.wallet_id],
    )) as Array<{ balance: string }>;

    return {
      transactionId: previous.id,
      status: previous.status,
      balance: currentWallet[0]?.balance ?? '0.00',
      currency: previous.currency,
      failureCode: previous.failure_code,
      duplicate: true,
    };
  }

  private async rejectBet(
    em: EntityManager,
    transactionId: string,
    input: ProcessBetInput,
    balance: string,
    currency: string,
  ): Promise<ProcessBetResult> {
    await em.execute(
      `
        UPDATE wager_transactions
        SET status = ?,
            failure_code = ?
        WHERE id = ?
      `,
      [
        WagerTransactionStatus.REJECTED,
        'INSUFFICIENT_FUNDS',
        transactionId,
      ],
    );

    await this.createOutboxEvent(
      em,
      transactionId,
      'WagerTransactionRejected',
      {
        transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    );

    return {
      transactionId,
      status: WagerTransactionStatus.REJECTED,
      balance,
      currency,
      failureCode: 'INSUFFICIENT_FUNDS',
      duplicate: false,
    };
  }

  private async rejectReversal(
    em: EntityManager,
    transactionId: string,
    input: ProcessReversalInput,
    balance: string,
    currency: string,
  ): Promise<ProcessBetResult> {
    const failureCode = 'REVERSAL_INSUFFICIENT_FUNDS';

    await em.execute(
      `
        UPDATE wager_transactions
        SET status = ?,
            failure_code = ?
        WHERE id = ?
      `,
      [
        WagerTransactionStatus.REJECTED,
        failureCode,
        transactionId,
      ],
    );

    await this.createOutboxEvent(
      em,
      transactionId,
      'WagerTransactionRejected',
      {
        transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        referenceTransactionId: input.referenceTransactionId,
        failureCode,
      },
    );

    return {
      transactionId,
      status: WagerTransactionStatus.REJECTED,
      balance,
      currency,
      failureCode,
      duplicate: false,
    };
  }

  private async createOutboxEvent(
    em: EntityManager,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await em.execute(
      `
        INSERT INTO outbox_events (
          id, aggregate_id, event_type, payload,
          status, attempts, available_at, created_at
        )
        VALUES (?, ?, ?, ?::jsonb, 'PENDING', 0, NOW(), NOW())
      `,
      [
        randomUUID(),
        aggregateId,
        eventType,
        JSON.stringify(payload),
      ],
    );
  }
}