import { Module } from '@nestjs/common';
import { paths } from '../common/paths';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ArtifactStore, LocalFolderArtifactStore } from './artifact-store';

/** Where Scans keep their Artifacts: a local folder under the data directory. */
@Module({
  providers: [
    {
      provide: ArtifactStore,
      useFactory: (config: AppConfig) => new LocalFolderArtifactStore(paths.artifacts(config.dataDir)),
      inject: [APP_CONFIG],
    },
  ],
  exports: [ArtifactStore],
})
export class ArtifactsModule {}
