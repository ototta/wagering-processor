
import { Migration } from '@mikro-orm/migrations';

export class Migration20261112182123 extends Migration {
  override name = 'Migration20261112182123';

  override up(): void {
    this.addSql(`
      ALTER TABLE "outbox_events"
      ADD COLUMN "locked_until" TIMESTAMPTZ NULL,
      ADD COLUMN "lock_token" UUID NULL;
    `);

    this.addSql(`
      CREATE INDEX "outbox_processing_lease_idx"
      ON "outbox_events" ("locked_until")
      WHERE "status" = 'PROCESSING';
    `);
  }

  override down(): void {
    this.addSql(`
      DROP INDEX IF EXISTS "outbox_processing_lease_idx";
    `);

    this.addSql(`
      ALTER TABLE "outbox_events"
      DROP COLUMN IF EXISTS "lock_token",
      DROP COLUMN IF EXISTS "locked_until";
    `);
  }
}
