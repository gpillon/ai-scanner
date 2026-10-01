import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfilesModule } from '../profiles/profiles.module';
import { ArchiveUploadInterceptor } from '../scans/archive-upload.interceptor';
import { LibrarySkill } from './entities/library-skill.entity';
import { SkillPack } from './entities/skill-pack.entity';
import { SkillLibrary } from './skill-library.service';
import { SkillPacks } from './skill-packs.service';
import { AdminSkillsController, SkillPacksController } from './skills.controller';

/** The Skill Library and Skill Packs (ADR-0008); `GET /api/skill-packs`, and their admin routes. */
@Module({
  imports: [TypeOrmModule.forFeature([LibrarySkill, SkillPack]), ProfilesModule],
  controllers: [SkillPacksController, AdminSkillsController],
  providers: [SkillLibrary, SkillPacks, ArchiveUploadInterceptor],
  exports: [SkillPacks],
})
export class SkillsModule {}
