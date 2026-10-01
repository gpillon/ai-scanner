import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ModelsModule } from '../models/models.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { Runner } from '../runner/runner';
import { RunnerModule } from '../runner/runner.module';
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

/** Scans: submission, the supervised Attempts (ADR-0001), Artifacts, deletion and retention. */
@Module({})
export class ScansModule {
  /** `runner` replaces the configured Runner, for tests. */
  static register(runner?: Runner): DynamicModule {
    return {
      module: ScansModule,
      imports: [TypeOrmModule.forFeature([Scan]), RunnerModule.register(runner), ArtifactsModule, ProfilesModule, ModelsModule, SkillsModule],
      controllers: [ScansController, GitController],
      providers: [ScansService, GitSources, ScanSupervisor, ScanEventsService, RetentionSweeper, ArchiveUploadInterceptor],
    };
  }
}
