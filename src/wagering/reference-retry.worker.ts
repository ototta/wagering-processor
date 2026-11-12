
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';

import { Money } from './money';
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from './wager-transaction.entity';

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

@Injectable()
export class ReferenceRetryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReferenceRetryWorker.name);

  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private readonly batchSize = 50;
  private readonly intervalMs = 5000;
  private readonly maxAttempts = 5;

  constructor(private readonly em: EntityManager) {}

  onModuleInit(): void {
    void this.runCycle();

    this.interval = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const processed = await this.processPendingReferences();

      if (processed > 0) {
        this.logger.log(
          `${processed} referência(s) pendente(s) processada(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Erro ao processar referências pendentes.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isRunning = false;
    }
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
            ORDER BY reference_next_retry_at ASC, created_at ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
          `,
          [
            WagerTransactionStatus.PENDING_REFERENCE,
            this.batchSize,
          ],
        )) as PendingReferenceRow[];

        for (const transaction of pending) {
          await this.processPendingTransaction(tx, transaction);
        }

        return pending.length;
      },
      { clear: true },
    );
  }

  private async processPendingTransaction(
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
      await this.handleMissingReference(tx, pending);
      return;
    }

    const original = originals[0];

    if (original.status !== WagerTransactionStatus.PROCESSED) {
      await this.rejectPending(
        tx,
        pending,
        'REFERENCE_TRANSACTION_NOT_PROCESSED',
        original.id,
      );
      return;
    }

    if (
      pending.type === WagerTransactionType.REFUND &&
      original.type !== WagerTransactionType.BET
    ) {
      await this.rejectPending(
        tx,
        pending,
        'INVALID_REFUND_REFERENCE',
        original.id,
      );
      return;
    }

    if (
      pending.type === WagerTransactionType.ROLLBACK &&
      ![
        WagerTransactionType.BET,
        WagerTransactionType.WIN,
        WagerTransactionType.REFUND,
      ].includes(original.type)
    ) {
      await this.rejectPending(
        tx,
        pending,
        'INVALID_ROLLBACK_REFERENCE',
        original.id,
      );
      return;
    }

    const sameProvider = original.provider_id === pending.provider_id;
    const sameWallet = original.wallet_id === pending.wallet_id;
    const sameRound = original.round_id === pending.round_id;
    const sameCurrency = original.currency === pending.currency;

    let sameAmount = false;

    if (sameCurrency) {
      sameAmount = Money.create(
        original.amount,
        original.currency,
      ).isEqualTo(
        Money.create(pending.amount, pending.currency),
      );
    }

    if (
      !sameProvider ||
      !sameWallet ||
      !sameRound ||
      !sameCurrency ||
      !sameAmount
    ) {
      await this.rejectPending(
        tx,
        pending,
        'REFERENCE_TRANSACTION_MISMATCH',
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
        LIMIT 1
      `,
      [original.id, WagerTransactionStatus.PROCESSED],
    )) as Array<{ id: string }>;

    if (previousReversals.length > 0) {
      await this.rejectPending(
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
      await this.rejectPending(
        tx,
        pending,
        'WALLET_NOT_FOUND',
        original.id,
      );
      return;
    }

    const wallet = wallets[0];

    if (wallet.currency !== pending.currency) {
      await this.rejectPending(
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

    if (!amount.isGreaterThan(Money.create('0.00', wallet.currency))) {
      await this.rejectPending(
        tx,
        pending,
        'INVALID_AMOUNT',
        original.id,
      );
      return;
    }

    const shouldCredit =
      pending.type === WagerTransactionType.REFUND ||
      original.type === WagerTransactionType.BET;

    const calculatedBalance = shouldCredit
      ? currentBalance.add(amount)
      : currentBalance.subtract(amount);

    if (calculatedBalance.isNegative()) {
      await this.rejectPending(
        tx,
        pending,
        'REVERSAL_INSUFFICIENT_FUNDS',
        original.id,
      );
      return;
    }

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
        UPDATE wager_transactions
        SET reference_transaction_id = ?,
            pending_reference_transaction_id = NULL
        WHERE id = ?
      `,
      [original.id, pending.id],
    );

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
            reference_next_retry_at = NULL,
            reference_last_attempt_at = NOW()
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
  }

  private async handleMissingReference(
    tx: EntityManager,
    pending: PendingReferenceRow,
  ): Promise<void> {
    const nextAttempt = pending.reference_retry_count + 1;

    if (nextAttempt >= this.maxAttempts) {
      await this.rejectPending(
        tx,
        pending,
        'REFERENCE_TRANSACTION_NOT_FOUND',
      );

      await tx.execute(
        `
          UPDATE wager_transactions
          SET reference_retry_count = ?,
              reference_last_attempt_at = NOW(),
              reference_next_retry_at = NULL
          WHERE id = ?
        `,
        [nextAttempt, pending.id],
      );

      return;
    }

    const delaySeconds = Math.min(
      5 * 2 ** nextAttempt,
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

  private async rejectPending(
    tx: EntityManager,
    pending: PendingReferenceRow,
    failureCode: string,
    referenceTransactionId?: string,
  ): Promise<void> {
    if (referenceTransactionId) {
      await tx.execute(
        `
          UPDATE wager_transactions
          SET reference_transaction_id = ?,
              pending_reference_transaction_id = NULL
          WHERE id = ?
        `,
        [referenceTransactionId, pending.id],
      );
    }

    await tx.execute(
      `
        UPDATE wager_transactions
        SET status = ?,
            failure_code = ?,
            reference_next_retry_at = NULL,
            reference_last_attempt_at = NOW()
        WHERE id = ?
      `,
      [
        WagerTransactionStatus.REJECTED,
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
        referenceTransactionId:
          referenceTransactionId ??
          pending.pending_reference_transaction_id,
        type: pending.type,
        failureCode,
      },
    );
  }

  private async createOutboxEvent(
    tx: EntityManager,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(
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
