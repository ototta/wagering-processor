
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

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
    fieldName: 'message_id',
    type: 'string',
    length: 255,
  })
  messageId!: string;

  @Property({
    type: 'string',
    length: 30,
  })
  status!: string;

  @Property({
    fieldName: 'received_at',
    type: 'datetime',
  })
  receivedAt: Date = new Date();

  @Property({
    fieldName: 'processed_at',
    type: 'datetime',
    nullable: true,
  })
  processedAt?: Date;
}
