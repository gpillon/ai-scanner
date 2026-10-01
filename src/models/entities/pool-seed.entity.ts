import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Present once SCANNER_MODELS has been imported. Seeding happens once, not whenever the pool is
 * empty: an admin who removed every model must not get them back at the next restart.
 */
@Entity('model_pool_seed')
export class PoolSeed {
  @PrimaryColumn({ type: 'integer' })
  id: number;

  @Column({ type: 'text' })
  seededAt: string;
}
