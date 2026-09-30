import { DynamicModule, Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** What every module may inject: the configuration and the Clock. */
@Global()
@Module({})
export class CoreModule {
  static register(config: AppConfig, clock: Clock = new SystemClock()): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: Clock, useValue: clock },
      ],
      exports: [APP_CONFIG, Clock],
    };
  }
}
