
import { Migration } from '@mikro-orm/migrations';

export class Migration20261111194000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN pending_reference_transaction_id UUID NULL,
      ADD COLUMN reference_retry_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN reference_next_retry_at TIMESTAMPTZ NULL,
      ADD COLUMN reference_last_attempt_at TIMESTAMPTZ NULL;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_reference_retry_count_check
      CHECK (reference_retry_count >= 0);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_pending_references
      ON wager_transactions (
        reference_next_retry_at,
        created_at
      )
      WHERE status = 'PENDING_REFERENCE'
        AND pending_reference_transaction_id IS NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS idx_wager_pending_references;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS wager_reference_retry_count_check;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS reference_last_attempt_at,
      DROP COLUMN IF EXISTS reference_next_retry_at,
      DROP COLUMN IF EXISTS reference_retry_count,
      DROP COLUMN IF EXISTS pending_reference_transaction_id;
    `);
  }
}
