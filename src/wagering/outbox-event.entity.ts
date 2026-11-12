
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

export enum OutboxEventStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

@Entity({ tableName: 'outbox_events' })
export class OutboxEvent {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    fieldName: 'aggregate_id',
    type: 'uuid',
  })
  aggregateId!: string;

  @Property({
    fieldName: 'event_type',
    type: 'string',
    length: 100,
  })
  eventType!: string;

  @Property({
    type: 'json',
  })
  payload!: Record<string, unknown>;

  @Property({
    type: 'string',
    length: 20,
  })
  status: OutboxEventStatus = OutboxEventStatus.PENDING;

  @Property({
    fieldName: 'attempts',
    type: 'integer',
  })
  attempts = 0;

  @Property({
    fieldName: 'available_at',
    type: 'datetime',
  })
  availableAt: Date = new Date();

  @Property({
    fieldName: 'published_at',
    type: 'datetime',
    nullable: true,
  })
  publishedAt?: Date;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
  })
  createdAt: Date = new Date();

  @Property({
    fieldName: 'last_error',
    type: 'text',
    nullable: true,
  })
  lastError?: string;

  @Property({
    fieldName: 'locked_until',
    type: 'datetime',
    nullable: true,
  })
  lockedUntil?: Date;

  @Property({
    fieldName: 'lock_token',
    type: 'uuid',
    nullable: true,
  })
  lockToken?: string;
}
