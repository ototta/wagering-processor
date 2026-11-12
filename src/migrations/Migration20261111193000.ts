
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111193000 extends Migration {
  override name = 'Migration20261111193000';

  override up(): void | Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_transactions_processed_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE reference_transaction_id IS NOT NULL
        AND status = 'PROCESSED'
        AND type IN ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_transactions_processed_reversal;
    `);
  }
}
