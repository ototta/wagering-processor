
import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

import { Wallet } from '../wallets/wallet.entity';

export enum WagerTransactionType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

@Entity({ tableName: 'wager_transactions' })
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => Wallet, {
    fieldName: 'wallet_id',
  })
  wallet!: Wallet;

  @Property({
    fieldName: 'provider_id',
    type: 'string',
    length: 100,
  })
  providerId!: string;

  @Property({
    fieldName: 'external_transaction_id',
    type: 'string',
    length: 255,
  })
  externalTransactionId!: string;

  @Property({
    fieldName: 'round_id',
    type: 'string',
    length: 255,
  })
  roundId!: string;

  @Property({
    type: 'string',
    length: 20,
  })
  type!: WagerTransactionType;

  @Property({
    type: 'string',
    length: 30,
  })
  status!: WagerTransactionStatus;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    fieldName: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId?: string | null;

  @Property({
    fieldName: 'pending_reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  pendingReferenceTransactionId?: string | null;

  @Property({
    fieldName: 'reference_retry_count',
    type: 'integer',
    default: 0,
  })
  referenceRetryCount: number = 0;

  @Property({
    fieldName: 'reference_next_retry_at',
    type: 'datetime',
    nullable: true,
  })
  referenceNextRetryAt?: Date | null;

  @Property({
    fieldName: 'reference_last_attempt_at',
    type: 'datetime',
    nullable: true,
  })
  referenceLastAttemptAt?: Date | null;

  @Property({
    fieldName: 'idempotency_key',
    type: 'string',
    length: 255,
    nullable: true,
  })
  idempotencyKey?: string;

  @Property({
    fieldName: 'failure_code',
    type: 'string',
    length: 100,
    nullable: true,
  })
  failureCode?: string;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
  })
  createdAt: Date = new Date();

  @Property({
    fieldName: 'processed_at',
    type: 'datetime',
    nullable: true,
  })
  processedAt?: Date;
}
