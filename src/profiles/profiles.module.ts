import { Module } from '@nestjs/common';
import { ProfileRegistry } from './profile-registry.service';
import { ProfilesController } from './profiles.controller';

/** Server-owned Scan Profiles (ADR-0004), and `GET /api/profiles`. */
@Module({
  controllers: [ProfilesController],
  providers: [ProfileRegistry],
  exports: [ProfileRegistry],
})
export class ProfilesModule {}
