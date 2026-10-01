import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ModelsModule } from '../models/models.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { Runner } from '../runner/runner';
import { RunnerModule } from '../runner/runner.module';
import { ScanSchedule } from '../schedules/entities/scan-schedule.entity';
import { ScanSchedules } from '../schedules/scan-schedules.service';
import { SchedulesController } from '../schedules/schedules.controller';
import { SkillsModule } from '../skills/skills.module';
import { ArchiveUploadInterceptor } from './archive-upload.interceptor';
import { Scan } from './entities/scan.entity';
import { RetentionSweeper } from './retention-sweeper.service';
import { ScanEventsService } from './scan-events.service';
import { ScanSupervisor } from './scan-supervisor.service';
import { ScansController } from './scans.controller';
import { GitController } from './git.controller';
import { GitSources } from './git-sources.service';
import { ScansService } from './scans.service';

/**
 * Scans: submission, the supervised Attempts (ADR-0001), Artifacts, deletion and retention; and
 * the Scan Schedules that submit them (ADR-0014), here so that they share this one ScansService.
 */
@Module({})
export class ScansModule {
  /** `runner` replaces the configured Runner, for tests. */
  static register(runner?: Runner): DynamicModule {
    return {
      module: ScansModule,
      imports: [
        TypeOrmModule.forFeature([Scan, ScanSchedule]),
        RunnerModule.register(runner),
        ArtifactsModule,
        ProfilesModule,
        ModelsModule,
        SkillsModule,
        RepositoriesModule,
      ],
      controllers: [ScansController, GitController, SchedulesController],
      providers: [ScansService, GitSources, ScanSupervisor, ScanEventsService, RetentionSweeper, ArchiveUploadInterceptor, ScanSchedules],
    };
  }
}
