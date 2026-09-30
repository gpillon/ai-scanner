import { DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PodmanRunner } from './podman-runner';
import { PlaceholderRunner, Runner } from './runner';

function createRunner(config: AppConfig): Runner {
  switch (config.runner) {
    case 'fake':
      return new PlaceholderRunner();
    case 'podman':
      return new PodmanRunner(config);
  }
}

/** The Runner that executes Attempts: the one `SCANNER_RUNNER` selects, unless one is given. */
@Module({})
export class RunnerModule {
  static register(override?: Runner): DynamicModule {
    return {
      module: RunnerModule,
      providers: [
        override
          ? { provide: Runner, useValue: override }
          : { provide: Runner, useFactory: createRunner, inject: [APP_CONFIG] },
      ],
      exports: [Runner],
    };
  }
}
