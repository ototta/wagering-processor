
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111191000 extends Migration {
  override name = 'Migration20261111191000';

  override up(): void | Promise<void> {
    this.addSql(`
      create or replace function prevent_ledger_modification()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception
          'Wallet ledger entries are immutable';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_immutable
      before update or delete
      on wallet_ledger_entries
      for each row
      execute function prevent_ledger_modification();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      drop trigger if exists wallet_ledger_immutable
      on wallet_ledger_entries;
    `);

    this.addSql(`
      drop function if exists prevent_ledger_modification();
    `);
  }
}
