
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balance!: string;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
  })
  createdAt: Date = new Date();

  @Property({
    fieldName: 'updated_at',
    type: 'datetime',
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
