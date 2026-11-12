
import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

import { Wallet } from '../wallets/wallet.entity';
import { WagerTransaction } from '../wagering/wager-transaction.entity';

export enum LedgerEntryType {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => Wallet, {
    fieldName: 'wallet_id',
  })
  wallet!: Wallet;

  @ManyToOne(() => WagerTransaction, {
    fieldName: 'wager_transaction_id',
  })
  wagerTransaction!: WagerTransaction;

  @Property({
    type: 'string',
    length: 20,
  })
  type!: LedgerEntryType;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({
    fieldName: 'balance_after',
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
  })
  createdAt: Date = new Date();
}
