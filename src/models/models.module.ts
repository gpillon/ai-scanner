import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../scans/entities/scan.entity';
import { AdminModelsController } from './admin-models.controller';
import { PoolModel } from './entities/pool-model.entity';
import { PoolSeed } from './entities/pool-seed.entity';
import { Provider } from './entities/provider.entity';
import { ModelPool } from './model-pool.service';
import { ModelsController } from './models.controller';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

/** The Model Pool and its Providers, stored in the database (ADR-0006); `GET /api/models`, and their admin routes. */
@Module({
  imports: [TypeOrmModule.forFeature([Provider, PoolModel, PoolSeed, Scan])],
  controllers: [ModelsController, ProvidersController, AdminModelsController],
  providers: [ModelPool, ProvidersService],
  exports: [ModelPool],
})
export class ModelsModule {}
