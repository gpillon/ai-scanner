import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';

@Injectable()
export class ModelPool {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  list(): { id: string; provider: string; default: boolean }[] {
    return this.config.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      default: m.id === this.config.defaultModel,
    }));
  }

  /** The requested model, or the Default Model. Undefined when the request is outside the pool. */
  resolve(requested?: string): string | undefined {
    if (requested === undefined || requested === '') return this.config.defaultModel;
    return this.config.models.some((m) => m.id === requested) ? requested : undefined;
  }
}
