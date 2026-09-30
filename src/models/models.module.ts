import { Module } from '@nestjs/common';
import { ModelPool } from './model-pool.service';
import { ModelsController } from './models.controller';

/** The Model Pool, and `GET /api/models`. */
@Module({
  controllers: [ModelsController],
  providers: [ModelPool],
  exports: [ModelPool],
})
export class ModelsModule {}
