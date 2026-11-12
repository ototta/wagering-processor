
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111185657 extends Migration {
  override name = 'Migration20261111185657';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(255) not null,
        "message_id" varchar(255) not null,
        "status" varchar(30) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("id"),
        constraint "inbox_provider_transaction_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "inbox_provider_message_unique"
          unique ("provider_id", "message_id")
      );
    `);

    this.addSql(`
      create table "outbox_events" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "payload" jsonb not null,
        "status" varchar(20) not null default 'PENDING',
        "attempts" int not null default 0,
        "available_at" timestamptz not null,
        "published_at" timestamptz null,
        "created_at" timestamptz not null,
        "last_error" text null,
        constraint "outbox_events_pkey" primary key ("id"),
        constraint "outbox_attempts_non_negative"
          check ("attempts" >= 0),
        constraint "outbox_status_valid"
          check ("status" in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'))
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(255) not null,
        "round_id" varchar(255) not null,
        "type" varchar(20) not null,
        "status" varchar(30) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "reference_transaction_id" uuid null,
        "idempotency_key" varchar(255) null,
        "failure_code" varchar(100) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,

        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_amount_positive" check ("amount" > 0),
        constraint "wager_currency_format"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_type_valid"
          check ("type" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_status_valid"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_provider_transaction_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_wallet_foreign"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wager_reference_foreign"
          foreign key ("reference_transaction_id") references "wager_transactions" ("id")
      );
    `);

    this.addSql(`
      create unique index "wager_idempotency_unique"
      on "wager_transactions" ("provider_id", "idempotency_key")
      where "idempotency_key" is not null;
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "wager_transaction_id" uuid not null,
        "type" varchar(20) not null,
        "amount" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "created_at" timestamptz not null,

        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "ledger_amount_non_zero" check ("amount" <> 0),
        constraint "ledger_balance_non_negative" check ("balance_after" >= 0),
        constraint "ledger_currency_format"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "ledger_transaction_unique"
          unique ("wager_transaction_id"),
        constraint "ledger_wallet_foreign"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "ledger_transaction_foreign"
          foreign key ("wager_transaction_id") references "wager_transactions" ("id")
      );
    `);

    this.addSql(`
      create index "wager_wallet_created_idx"
      on "wager_transactions" ("wallet_id", "created_at");
    `);

    this.addSql(`
      create index "ledger_wallet_created_idx"
      on "wallet_ledger_entries" ("wallet_id", "created_at");
    `);

    this.addSql(`
      create index "outbox_pending_idx"
      on "outbox_events" ("available_at")
      where "status" = 'PENDING';
    `);
  }

  override down(): void | Promise<void> {
    this.addSql('drop table if exists "wallet_ledger_entries" cascade;');
    this.addSql('drop table if exists "inbox_messages" cascade;');
    this.addSql('drop table if exists "outbox_events" cascade;');
    this.addSql('drop table if exists "wager_transactions" cascade;');
  }
}
