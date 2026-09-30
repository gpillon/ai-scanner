import { DynamicModule, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BearerGuard } from './auth.guard';
import { ArtifactStore, LocalFolderArtifactStore } from './artifact-store';
import { Clock, SystemClock } from './clock';
import { APP_CONFIG, AppConfig } from './config';
import { DiscoveryController, ScansController } from './controllers';
import { ModelPool } from './model-pool';
import { paths } from './paths';
import { ProfileRegistry } from './profiles';
import { RetentionSweeper } from './retention-sweeper';
import { Runner, UnconfiguredRunner } from './runner';
import { Scan } from './scan.entity';
import { ScansService } from './scans.service';
import { ScanSupervisor } from './supervisor';
import { ArchiveUploadInterceptor } from './upload.interceptor';

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
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: paths.database(config.dataDir),
          entities: [Scan],
          synchronize: true, // PoC: the schema is one table
        }),
        TypeOrmModule.forFeature([Scan]),
      ],
      controllers: [ScansController, DiscoveryController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: BearerGuard },
        { provide: Clock, useValue: overrides.clock ?? new SystemClock() },
        { provide: Runner, useValue: overrides.runner ?? new UnconfiguredRunner() },
        { provide: ArtifactStore, useValue: new LocalFolderArtifactStore(paths.artifacts(config.dataDir)) },
        ArchiveUploadInterceptor,
        ProfileRegistry,
        ModelPool,
        ScansService,
        ScanSupervisor,
        RetentionSweeper,
      ],
    };
  }
}

/** Pipes and OpenAPI shared by `main.ts` and the tests. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ai-scanner')
      .setDescription('Submit a Source Archive, poll the Scan, download its Report.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  // Served outside the bearer guard so clients can generate code from it.
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
}
