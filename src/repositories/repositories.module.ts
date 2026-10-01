import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitSources } from '../scans/git-sources.service';
import { ScanSchedule } from '../schedules/entities/scan-schedule.entity';
import { SavedRepository } from './entities/saved-repository.entity';
import { RepositoriesController } from './repositories.controller';
import { SavedRepositories } from './saved-repositories.service';

/** Saved Repositories (ADR-0014): `/api/repositories`, and what Scans read them through. */
@Module({
  imports: [TypeOrmModule.forFeature([SavedRepository, ScanSchedule])],
  controllers: [RepositoriesController],
  // GitSources holds nothing but the configuration: a copy of its own here is harmless.
  providers: [SavedRepositories, GitSources],
  exports: [SavedRepositories],
})
export class RepositoriesModule {}
