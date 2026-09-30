import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock } from './common/clock';
import { BearerGuard } from './common/guards/bearer.guard';
import { paths } from './common/paths';
import { AppConfig } from './config/app-config';
import { CoreModule } from './core/core.module';
import { ModelsModule } from './models/models.module';
import { ProfilesModule } from './profiles/profiles.module';
import { Runner } from './runner/runner';
import { Scan } from './scans/entities/scan.entity';
import { ScansModule } from './scans/scans.module';

export interface AppOverrides {
  runner?: Runner;
  clock?: Clock;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(config, overrides.clock),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: paths.database(config.dataDir),
          entities: [Scan],
          synchronize: true, // PoC: the schema is one table
        }),
        ScansModule.register(overrides.runner),
        ProfilesModule,
        ModelsModule,
      ],
      // Every route requires the shared token (ADR-0002); the UI and API docs are not routes.
      providers: [{ provide: APP_GUARD, useClass: BearerGuard }],
    };
  }
}
