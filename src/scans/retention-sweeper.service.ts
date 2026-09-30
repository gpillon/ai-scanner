import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig, DAY_MS } from '../config/app-config';
import { ScansService } from './scans.service';

/** Deletes Scans older than the retention period; an expired Scan behaves like a deleted one. */
@Injectable()
export class RetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly scans: ScansService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.error(e)), this.config.sweepIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.retentionDays * DAY_MS).toISOString();
    let removed = 0;
    for (const id of await this.scans.idsCreatedBefore(cutoff)) {
      try {
        await this.scans.delete(id);
        removed++;
      } catch (e) {
        if (!(e instanceof NotFoundException)) this.log.error(`Could not expire Scan ${id}: ${e}`);
      }
    }
    return removed;
  }
}
