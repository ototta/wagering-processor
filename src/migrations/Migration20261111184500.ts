
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111184500 extends Migration {
  override name = 'Migration20261111184500';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20,2) not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),

        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_balance_non_negative"
          check ("balance" >= 0),
        constraint "wallets_currency_format"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_player_currency_unique"
          unique ("player_id", "currency")
      );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
