import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock } from './common/clock';
import { AuthModule } from './auth/auth.module';
import { paths } from './common/paths';
import { AppConfig } from './config/app-config';
import { CoreModule } from './core/core.module';
import { ModelsModule } from './models/models.module';
import { ProfilesModule } from './profiles/profiles.module';
import { Runner } from './runner/runner';
import { PoolModel } from './models/entities/pool-model.entity';
import { PoolSeed } from './models/entities/pool-seed.entity';
import { Provider } from './models/entities/provider.entity';
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
        AuthModule,
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: paths.database(config.dataDir),
          entities: [Scan, Provider, PoolModel, PoolSeed],
          synchronize: true, // PoC: the schema is one table
        }),
        ScansModule.register(overrides.runner),
        ProfilesModule,
        ModelsModule,
      ],
    };
  }
}
