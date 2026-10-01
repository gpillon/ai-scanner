import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { ModelOptions } from '../model-options';

/** A model of the Model Pool: a model a Provider serves, under the id Scans name it by. */
@Entity('models')
export class PoolModel {
  /** What callers pass as `model` and Scans record. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  providerId: string;

  /** The model's name at the Provider, e.g. `claude-sonnet-5-5`. */
  @Column({ type: 'text' })
  name: string;

  /** Disabled models are not offered for new Scans; Scans already using one still run. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** The Default Model: at most one. */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  /** How the model runs, e.g. its thinking (ADR-0013); null: the model's own way. */
  @Column({ type: 'simple-json', nullable: true })
  modelOptions: ModelOptions | null;

  /** Listing order. */
  @Column({ type: 'integer' })
  position: number;

  @Column({ type: 'text' })
  createdAt: string;
}
